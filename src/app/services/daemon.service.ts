import {Injectable} from '@angular/core';
import path from 'path';
import {LoggerLevel} from './app.service';
import {FileService} from './file.service';
import {ExecuteService} from './execute.service';
import {LeappBaseError} from '../errors/leapp-base-error';
import {HttpClient} from '@angular/common/http';
import {environment} from '../../environments/environment';
import {NativeService} from './native-service';


export const apiRoot = '/api/v1';
export enum DaemonUrls {
  openWebsocketConnection = `/websocket/register-client`, // GET
  iamUserConfirmMfaCode = `/aws/iam-user-sessions/:id/confirm-mfa-token`, // POST

  createIamUser = `/aws/iam-user-sessions`, // POST
  getIamUser = `/aws/iam-user-sessions/:id`, // GET
  editIamUser = `/aws/iam-user-sessions/:id`, // PUT
  deleteIamUser = `/aws/iam-user-sessions/:id`, // DELETE
  startIamUserSession = `/aws/iam-user-sessions/:id/start`, // POST
  stopIamUserSession = `/aws/iam-user-sessions/:id/stop`, // POST
}

export enum WSDaemonMessage {
  mfaTokenRequest
}

@Injectable({
  providedIn: 'root'
})
export class DaemonService extends NativeService {

  constructor(
    private httpClient: HttpClient,
    private fileService: FileService,
    private executeService: ExecuteService) {
    super();
  }

  async launchDaemon() {

    // Calling leapp-daemon
    let daemonPath = path.join(this.process.resourcesPath, 'extraResources').substring(1);

    if (!environment.production) {
      daemonPath = `./src/assets/extraResources`;
    }

    const daemonFile = daemonPath + '/leapp_daemon';

    try {
      if (this.fileService.exists(daemonFile)) {
        const result = await this.executeService.executeAbsolute(`${daemonPath}/awesomeService '${daemonFile}'`);
      }
    } catch(err) {
      throw new LeappBaseError('Daemon Error', this, LoggerLevel.warn, err);
    }
  }

  callDaemon(url: DaemonUrls, params: any, httpVerb: string): Promise<any> {

    const transformVariables = (text) => text.replaceAll(':id', params['id']);
    const daemonCommandUrl = transformVariables(`http://localhost:8080${apiRoot}${url}`);

    return this.httpClient.request(httpVerb, daemonCommandUrl, {body: params, responseType:'json'}).toPromise().catch((err) => {
      throw new LeappBaseError('Daemon Error', this, LoggerLevel.warn, err.error.error);
    });
  }
}
