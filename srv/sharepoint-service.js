const cds = require('@sap/cds');

/**
 * SharePoint Service - Microsoft Graph Integration
 *
 * Simplified: no local file downloads, no disk storage.
 * Files are streamed directly by fragmentProcessor.
 */
module.exports = class SharePointService extends cds.ApplicationService {

  async init() {
    this.destinationName = 'GRAPH_SP_FILECAP';
    this._accessToken = null;
    this._tokenExpiry = null;

    this.on('listFiles', this.handleListFiles);
    this.on('listFilesInFolder', this.handleListFilesInFolder);
    this.on('getDownloadUrl', this.handleGetDownloadUrl);
    this.on('createJobFromSharePoint', this.handleCreateJobFromSharePoint);

    await super.init();
    console.log('[SharePoint] Service initialized');
  }

  // ══════════════════════════════════════════
  // Configuration
  // ══════════════════════════════════════════
  async getConfig() {
    if (process.env.GRAPH_TENANT_ID && process.env.GRAPH_CLIENT_ID && process.env.GRAPH_CLIENT_SECRET) {
      return {
        useDestination: false,
        tenantId: process.env.GRAPH_TENANT_ID,
        clientId: process.env.GRAPH_CLIENT_ID,
        clientSecret: process.env.GRAPH_CLIENT_SECRET,
        driveId: process.env.GRAPH_DRIVE_ID || 'b!ONJaTXThrUSlIF7Q4Wx2m4YsdEQF1mlDvlvUMMvUsMg2mQ75FZwDSYW6p_xyGQV_',
        folderItemId: process.env.GRAPH_FOLDER_ID || '01EYS6Y2JYBEFXDYCSRRHKGP5H4U2TBLN3',
      };
    }

    if (process.env.VCAP_SERVICES) {
      try {
        const vcapServices = JSON.parse(process.env.VCAP_SERVICES);
        if (vcapServices.destination) {
          const { getDestination } = await import('@sap-cloud-sdk/connectivity');
          const destination = await getDestination({ destinationName: this.destinationName });
          if (destination) {
            // Intentar leer driveId y folderItemId desde múltiples ubicaciones
            let driveId = 
              destination.originalProperties?.driveId ||
              destination.destinationConfiguration?.driveId ||
              process.env.GRAPH_DRIVE_ID ||
              'b!ONJaTXThrUSlIF7Q4Wx2m4YsdEQF1mlDvlvUMMvUsMg2mQ75FZwDSYW6p_xyGQV_';
            
            let folderItemId = 
              destination.originalProperties?.folderItemId ||
              destination.destinationConfiguration?.folderItemId ||
              process.env.GRAPH_FOLDER_ID ||
              '01EYS6Y2JYBEFXDYCSRRHKGP5H4U2TBLN3';

            // También intentar leer desde VCAP_SERVICES directamente
            if (vcapServices.destination && Array.isArray(vcapServices.destination)) {
              const destConfig = vcapServices.destination.find(d => d.name === this.destinationName);
              if (destConfig && destConfig.credentials) {
                driveId = destConfig.credentials.driveId || driveId;
                folderItemId = destConfig.credentials.folderItemId || folderItemId;
              }
            }

            console.log(`[SharePoint] Using destination: driveId=${driveId ? 'found' : 'missing'}, folderItemId=${folderItemId ? 'found' : 'missing'}`);

            return {
              useDestination: true,
              destination,
              driveId,
              folderItemId,
            };
          }
        }
      } catch (e) {
        console.warn('[SharePoint] Destination not available:', e.message);
      }
    }

    console.error('[SharePoint] No Graph credentials configured!');
    return {
      useDestination: false,
      tenantId: null, clientId: null, clientSecret: null,
      driveId: process.env.GRAPH_DRIVE_ID || 'b!ONJaTXThrUSlIF7Q4Wx2m4YsdEQF1mlDvlvUMMvUsMg2mQ75FZwDSYW6p_xyGQV_',
      folderItemId: process.env.GRAPH_FOLDER_ID || '01EYS6Y2JYBEFXDYCSRRHKGP5H4U2TBLN3',
    };
  }

  // ══════════════════════════════════════════
  // OAuth2 token (cached)
  // ══════════════════════════════════════════
  async getAccessToken(config) {
    if (!config.tenantId || !config.clientId || !config.clientSecret) {
      throw new Error('Missing Graph API credentials');
    }
    if (this._accessToken && this._tokenExpiry && Date.now() < this._tokenExpiry) {
      return this._accessToken;
    }

    const axios = require('axios');
    const tokenUrl = `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`;
    const params = new URLSearchParams();
    params.append('client_id', config.clientId);
    params.append('client_secret', config.clientSecret);
    params.append('scope', 'https://graph.microsoft.com/.default');
    params.append('grant_type', 'client_credentials');

    const response = await axios.post(tokenUrl, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    });

    this._accessToken = response.data.access_token;
    this._tokenExpiry = Date.now() + (response.data.expires_in - 300) * 1000;
    return this._accessToken;
  }

  // ══════════════════════════════════════════
  // Graph API request
  // ══════════════════════════════════════════
  async executeGraphRequest(graphPath, options = {}) {
    const config = await this.getConfig();
    const axios = require('axios');

    if (config.useDestination) {
      try {
        const { executeHttpRequest } = await import('@sap-cloud-sdk/http-client');
        return await executeHttpRequest(
          { destinationName: this.destinationName },
          { method: options.method || 'GET', url: graphPath, headers: options.headers, responseType: options.responseType }
        );
      } catch (e) {
        console.error('[SharePoint] Cloud SDK request failed:', e.message);
        throw e;
      }
    }

    const token = await this.getAccessToken(config);
    return axios({
      method: options.method || 'GET',
      url: `https://graph.microsoft.com${graphPath}`,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...options.headers },
      responseType: options.responseType || 'json',
      timeout: options.timeout || 30000,
    });
  }

  mapFileResponse(item) {
    return {
      itemId: item.id,
      name: item.name,
      size: item.size || 0,
      mimeType: item.file?.mimeType || 'application/octet-stream',
      webUrl: item.webUrl,
      createdAt: item.createdDateTime ? new Date(item.createdDateTime) : null,
      modifiedAt: item.lastModifiedDateTime ? new Date(item.lastModifiedDateTime) : null,
    };
  }

  // ══════════════════════════════════════════
  // Handlers
  // ══════════════════════════════════════════

  async handleListFiles(req) {
    try {
      const config = await this.getConfig();
      const { driveId, folderItemId } = config;
      if (!driveId || !folderItemId) return req.error(500, 'Missing driveId or folderItemId');

      const response = await this.executeGraphRequest(
        `/v1.0/drives/${driveId}/items/${folderItemId}/children`
      );
      const items = response.data?.value || [];
      return items.filter((i) => i.file).map((i) => this.mapFileResponse(i));
    } catch (error) {
      console.error('[SharePoint] Error listing files:', error.message);
      return req.error(500, `Failed to list files: ${error.message}`);
    }
  }

  async handleListFilesInFolder(req) {
    try {
      const { folderId } = req.data;
      const config = await this.getConfig();
      if (!config.driveId) return req.error(500, 'Missing driveId');

      const response = await this.executeGraphRequest(
        `/v1.0/drives/${config.driveId}/items/${folderId}/children`
      );
      const items = response.data?.value || [];
      return items.filter((i) => i.file).map((i) => this.mapFileResponse(i));
    } catch (error) {
      console.error('[SharePoint] Error listing folder:', error.message);
      return req.error(500, `Failed to list folder: ${error.message}`);
    }
  }

  async handleGetDownloadUrl(req) {
    try {
      const { itemId } = req.data;
      const config = await this.getConfig();
      if (!config.driveId || !itemId) return req.error(400, 'Missing driveId or itemId');

      const response = await this.executeGraphRequest(
        `/v1.0/drives/${config.driveId}/items/${itemId}`
      );
      const downloadUrl = response.data['@microsoft.graph.downloadUrl'];
      if (!downloadUrl) return req.error(404, 'Download URL not available');

      return { url: downloadUrl, expiresAt: new Date(Date.now() + 3600000) };
    } catch (error) {
      console.error('[SharePoint] GetDownloadUrl error:', error.message);
      return req.error(500, `Failed to get download URL: ${error.message}`);
    }
  }

  /**
   * Create job from SharePoint file (called by UI)
   * No local download - fragmentProcessor streams directly.
   */
  async handleCreateJobFromSharePoint(req) {
    try {
      const { itemId, fileName } = req.data;
      const config = await this.getConfig();
      if (!config.driveId || !itemId) return req.error(400, 'Missing driveId or itemId');

      console.log(`[SharePoint] Creating job for: ${fileName}`);

      // 1. Get file metadata + download URL
      const metaResponse = await this.executeGraphRequest(
        `/v1.0/drives/${config.driveId}/items/${itemId}`
      );
      const fileInfo = metaResponse.data;
      const downloadUrl = fileInfo['@microsoft.graph.downloadUrl'];
      const fileSize = fileInfo.size || 0;

      if (!downloadUrl) return req.error(404, 'Download URL not available');

      // 2. Create UploadJob in HANA (status: QUEUED)
      const db = await cds.connect.to('db');
      const jobId = cds.utils.uuid();

      await db.create('fileproc.UploadJob', {
        ID: jobId,
        fileName,
        sharePointItemId: itemId,
        totalBytes: fileSize,
        status: 'QUEUED',
      });

      console.log(`[SharePoint] Job created: ${jobId} (${fileName}, ${Math.round(fileSize / 1024 / 1024)}MB)`);

      // 3. Enqueue for processing (respects semaphore)
      const fragmentProcessor = require('./processing/fragmentProcessor');
      const started = await fragmentProcessor.enqueue(jobId, downloadUrl);

      if (started) {
        console.log(`[SharePoint] Job ${jobId} started immediately`);
      } else {
        console.log(`[SharePoint] Job ${jobId} queued (another job is processing)`);
      }

      return jobId;
    } catch (error) {
      console.error('[SharePoint] CreateJobFromSharePoint error:', error.message);
      return req.error(500, `Failed to create job: ${error.message}`);
    }
  }
};
