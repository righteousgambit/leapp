import {Injectable} from '@angular/core';
import {CredentialsInfo} from '../../../../models/credentials-info';
import {WorkspaceService} from '../../../workspace.service';
import {AwsIamUserSession} from '../../../../models/aws-iam-user-session';
import {KeychainService} from '../../../keychain.service';
import {environment} from '../../../../../environments/environment';
import {Session} from '../../../../models/session';
import {AppService, LoggerLevel} from '../../../app.service';
import AWS from 'aws-sdk';
import {GetSessionTokenResponse} from 'aws-sdk/clients/sts';
import {FileService} from '../../../file.service';
import {Constants} from '../../../../models/constants';
import {LeappAwsStsError} from '../../../../errors/leapp-aws-sts-error';
import {LeappParseError} from '../../../../errors/leapp-parse-error';
import {LeappMissingMfaTokenError} from '../../../../errors/leapp-missing-mfa-token-error';
import {DaemonService, DaemonUrls} from '../../../daemon.service';
import {LeappBaseError} from '../../../../errors/leapp-base-error';
import {SessionService} from '../../../session.service';
import {SessionType} from '../../../../models/session-type';
import {AwsIamRoleChainedSession} from '../../../../models/aws-iam-role-chained-session';
import {SessionStatus} from '../../../../models/session-status';
import {AwsSessionService} from '../aws-session.service';

export interface AwsIamUserSessionRequest {
  accountName: string;
  accessKey: string;
  secretKey: string;
  region: string;
  mfaDevice?: string;
}

@Injectable({
  providedIn: 'root'
})
export class AwsIamUserService extends AwsSessionService {

  constructor(
    protected workspaceService: WorkspaceService,
    private keychainService: KeychainService,
    private appService: AppService,
    private fileService: FileService,
    private daemonService: DaemonService) {
    super(workspaceService);
  }

  async start(sessionId: string): Promise<void> {
    try {
      this.sessionLoading(sessionId);

      await this.daemonService.callDaemon(DaemonUrls.startIamUserSession, { id: sessionId }, 'POST');

      this.sessionActivate(sessionId);
    } catch (error) {
      this.sessionError(sessionId, error);
    }
  }

  async rotate(sessionId: string): Promise<void> {
    return;
  }

  async stop(sessionId: string): Promise<void> {
    try {
      await this.daemonService.callDaemon(DaemonUrls.stopIamUserSession, { id: sessionId }, 'POST');

      this.sessionDeactivated(sessionId);
      return;
    } catch (error) {
      this.sessionError(sessionId, error);
    }
  }

  async create(accountRequest: AwsIamUserSessionRequest, profileId: string): Promise<void> {
    const iamUserCreateDto = {
      name: accountRequest.accountName,
      region: accountRequest.region,
      mfaDevice: accountRequest.mfaDevice,
      awsNamedProfileName: profileId,
      awsAccessKeyId: accountRequest.accessKey,
      awsSecretAccessKey: accountRequest.secretKey
    };

    try {
      const response = await this.daemonService.callDaemon(DaemonUrls.createIamUser, iamUserCreateDto, 'POST');
      // Temporary save also on local workspace
      const session = new AwsIamUserSession(accountRequest.accountName, accountRequest.region, profileId, accountRequest.mfaDevice);
      session.sessionId = response.data;

      console.log(session);

      this.workspaceService.addSession(session);
    } catch (err) {
      throw new LeappBaseError('Daemon Error', this, LoggerLevel.warn, err.message);
    }
  }

  async update(sessionId: string, session: Session, accessKey?: string, secretKey?: string) {
    const sessions = this.list();
    const index = sessions.findIndex(sess => sess.sessionId === sessionId);

    if(index > -1) {
      try {
        const iamUserEditDto = {
          id: sessionId,
          name: (session as AwsIamUserSession).sessionName,
          region: (session as AwsIamUserSession).region,
          mfaDevice: (session as AwsIamUserSession).mfaDevice,
          awsNamedProfileName: (session as AwsIamUserSession).profileId,
          awsAccessKeyId: accessKey,
          awsSecretAccessKey: secretKey
        };

        await this.daemonService.callDaemon(DaemonUrls.editIamUser, iamUserEditDto, 'PUT');

        this.workspaceService.sessions[index] = session;
        this.workspaceService.sessions = [...this.workspaceService.sessions];
        return;
      } catch (error) {
        this.sessionError(sessionId, error);
      }
    }
  }

  async delete(sessionId: string): Promise<void> {
    try {
      if (this.get(sessionId).status === SessionStatus.active) {
        await this.stop(sessionId);
      }
      this.listIamRoleChained(this.get(sessionId)).forEach(sess => {
        if (sess.status === SessionStatus.active) {
          this.stop(sess.sessionId);
        }

        this.daemonService.callDaemon(DaemonUrls.deleteIamUser, { id: sess.sessionId }, 'DELETE');
        this.workspaceService.removeSession(sess.sessionId);
      });

      this.daemonService.callDaemon(DaemonUrls.deleteIamUser, { id: sessionId }, 'DELETE');
      this.workspaceService.removeSession(sessionId);

    } catch(error) {
      this.sessionError(sessionId, error);
    }
  }

  applyCredentials(sessionId: string, credentialsInfo: CredentialsInfo): Promise<void> {
    return Promise.resolve(undefined);
  }

  deApplyCredentials(sessionId: string): Promise<void> {
    return Promise.resolve(undefined);
  }

  generateCredentials(sessionId: string): Promise<CredentialsInfo> {
    return Promise.resolve(undefined);
  }
}
