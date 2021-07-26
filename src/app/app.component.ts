import {Component, OnInit} from '@angular/core';
import {environment} from '../environments/environment';
import {FileService} from './services/file.service';
import {AppService, LoggerLevel} from './services/app.service';
import {Router} from '@angular/router';
import {WorkspaceService} from './services/workspace.service';
import {Workspace} from './models/workspace';
import {setTheme} from 'ngx-bootstrap/utils';
import {TimerService} from './services/timer.service';
import {RotationService} from './services/rotation.service';
import {SessionFactoryService} from './services/session-factory.service';
import {UpdaterService} from './services/updater.service';
import compareVersions from 'compare-versions';
import {RetrocompatibilityService} from './services/retrocompatibility.service';
import {LeappParseError} from './errors/leapp-parse-error';
import {apiRoot, DaemonService, DaemonUrls, WSDaemonMessage} from './services/daemon.service';
import {LeappBaseError} from './errors/leapp-base-error';
import {Constants} from './models/constants';
import {AwsIamUserService} from './services/session/aws/methods/aws-iam-user.service';
import {LeappMissingMfaTokenError} from "./errors/leapp-missing-mfa-token-error";

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export class AppComponent implements OnInit {
  private mfaSemaphore = false;

  /* Main app file: launches the Angular framework inside Electron app */
  constructor(
    private app: AppService,
    private workspaceService: WorkspaceService,
    private retrocompatibilityService: RetrocompatibilityService,
    private fileService: FileService,
    private rotationService: RotationService,
    private sessionProviderService: SessionFactoryService,
    private router: Router,
    private timerService: TimerService,
    private updaterService: UpdaterService,
    private daemonService: DaemonService,
    private awsIamUserService: AwsIamUserService
  ) {}

  async ngOnInit() {
    // We get the right moment to set an hook to app close
    const ipc = this.app.getIpcRenderer();
    ipc.on('app-close', () => {
      this.app.logger('Preparing for closing instruction...', LoggerLevel.info, this);
      this.beforeCloseInstructions();
    });

    // Use ngx bootstrap 4
    setTheme('bs4');

    if (environment.production) {
      // Clear both info and warn message in production
      // mode without removing them from code actually
      console.warn = () => {};
      console.log = () => {};
    }

    // Prevent Dev Tool to show on production mode
    this.app.blockDevToolInProductionMode();

    // Before retrieving an actual copy of the workspace we
    // check and in case apply, our retro compatibility service
    if (this.retrocompatibilityService.isRetroPatchNecessary()) {
      await this.retrocompatibilityService.adaptOldWorkspaceFile();
    }

    let workspace;
    try {
      workspace = this.workspaceService.get();
    } catch {
      throw new LeappParseError(this, 'We had trouble parsing your Leapp-lock.json file. It is either corrupt, obsolete, or with an error.');
    }

    // Check the existence of a pre-Leapp credential file and make a backup
    this.showCredentialBackupMessageIfNeeded(workspace);

    // All sessions start stopped when app is launched
    if (workspace.sessions.length > 0) {
      workspace.sessions.forEach(sess => {
        const concreteSessionService = this.sessionProviderService.getService(sess.type);
        concreteSessionService.stop(sess.sessionId);
      });
    }

    // Start Global Timer (1s)
    this.timerService.start(this.rotationService.rotate.bind(this.rotationService));

    // Launch Auto Updater Routines
    this.manageAutoUpdate();

    // Launch Daemon
    this.daemonService.launchDaemon();
    // This set websocket
    this.launchDaemonWebSocket();

    // Go to initial page if no sessions are already created or
    // go to the list page if is your second visit
    if (workspace.sessions.length > 0) {
      this.router.navigate(['/sessions', 'session-selected']);
    } else {
      this.router.navigate(['/start', 'start-page']);
    }
  }

  /**
   * This is an hook on the closing app to remove credential file and force stop using them
   */
  private beforeCloseInstructions() {
    // Check if we are here
    this.app.logger('Closing app with cleaning process...', LoggerLevel.info, this);

    // We need the Try/Catch as we have a the possibility to call the method without sessions
    try {
      // Clean the config file
      this.app.cleanCredentialFile();
    } catch (err) {
      this.app.logger('No sessions to stop, skipping...', LoggerLevel.error, this, err.stack);
    }

    // Finally quit
    this.app.quit();
  }

  /**
   * Show that we created a copy of original credential file if present in the system
   */
  private showCredentialBackupMessageIfNeeded(workspace: Workspace) {
    const oldAwsCredentialsPath = this.app.getOS().homedir() + '/' + environment.credentialsDestination;
    const newAwsCredentialsPath = oldAwsCredentialsPath + '.leapp.bkp';
    const check = workspace.sessions.length === 0 &&
                  this.app.getFs().existsSync(oldAwsCredentialsPath) &&
                  !this.app.getFs().existsSync(newAwsCredentialsPath);

    this.app.logger(`Check existing credential file: ${check}`, LoggerLevel.info, this);

    if (check) {
      this.app.getFs().renameSync(oldAwsCredentialsPath, newAwsCredentialsPath);
      this.app.getFs().writeFileSync(oldAwsCredentialsPath,'');
      this.app.getDialog().showMessageBox({
        type: 'info',
        icon: __dirname + '/assets/images/Leapp.png',
        message: 'You had a previous credential file. We made a backup of the old one in the same directory before starting.'
      });
    }
  }

  /**
   * Launch Updater process
   *
   * @private
   */
  private manageAutoUpdate(): void {
    let savedVersion;

    try {
      savedVersion = this.updaterService.getSavedAppVersion();
    } catch (error) {
      savedVersion = this.updaterService.getCurrentAppVersion();
    }

    try {
      if (compareVersions(savedVersion, this.updaterService.getCurrentAppVersion()) <= 0) {
        // We always need to maintain this order: fresh <= saved <= online
        this.updaterService.updateVersionJson(this.updaterService.getCurrentAppVersion());
      }
    } catch (error) {
      this.updaterService.updateVersionJson(this.updaterService.getCurrentAppVersion());
    }

    const ipc = this.app.getIpcRenderer();
    ipc.on('UPDATE_AVAILABLE', async (_, info) => {

      const releaseNote = await this.updaterService.getReleaseNote();
      this.updaterService.setUpdateInfo(info.version, info.releaseName, info.releaseDate, releaseNote);
      if (this.updaterService.isUpdateNeeded()) {
        this.updaterService.updateDialog();
        this.workspaceService.sessions = [...this.workspaceService.sessions];
      }
    });
  }

  private launchDaemonWebSocket() {
    const webSocket = new WebSocket(`ws://localhost:8080${apiRoot}${DaemonUrls.openWebsocketConnection}`);
    webSocket.onerror = (evt) => {};
    webSocket.onclose = (evt) => {};

    webSocket.onmessage = async (evt) => {
      const data = JSON.parse(evt.data);

      if (data.MessageType === WSDaemonMessage.mfaTokenRequest && !this.mfaSemaphore) {
        this.mfaSemaphore = true;

        const sessionId = JSON.parse(data.Data).SessionId;
        const response = await this.daemonService.callDaemon(DaemonUrls.getIamUser, { id: sessionId }, 'GET');
        const sessionAlias = response.data.Name;

        this.app.inputDialog('Insert MFA Code', 'set code...', `Please add code for ${sessionAlias} session`, async (res) => {

          try {
            if (res !== Constants.confirmClosed) {
              await this.daemonService.callDaemon(DaemonUrls.iamUserConfirmMfaCode, {id: sessionId, mfaToken: res}, 'POST');
            } else {
              throw new LeappBaseError('Mfa Error', this, LoggerLevel.warn, 'Missing Mfa Code');
            }
          } catch(err) {
            await this.awsIamUserService.stop(sessionId);
            throw new LeappMissingMfaTokenError(this, err.message);
          } finally {
            this.mfaSemaphore = false;
          }

        });

      }
    };
  }
}
