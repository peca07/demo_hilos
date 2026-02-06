const cds = require('@sap/cds');
const path = require('path');
const fs = require('fs');

/**
 * SharePoint Service - Microsoft Graph Integration
 * Uses BTP Destination for secure credential storage (production)
 * Falls back to environment variables for local development
 */
module.exports = class SharePointService extends cds.ApplicationService {
  
  async init() {
    // Configuration
    this.destinationName = 'GRAPH_SP_FILECAP';
    this._accessToken = null;
    this._tokenExpiry = null;
    
    // Register handlers
    this.on('listFiles', this.handleListFiles);
    this.on('listFilesInFolder', this.handleListFilesInFolder);
    this.on('downloadFile', this.handleDownloadFile);
    this.on('getDownloadUrl', this.handleGetDownloadUrl);
    this.on('createJobFromSharePoint', this.handleCreateJobFromSharePoint);
    
    await super.init();
    console.log('[SharePoint] Service initialized');
  }

  /**
   * Get configuration from Destination or environment
   */
  async getConfig() {
    // Try to use BTP Destination service first (production)
    if (process.env.VCAP_SERVICES) {
      try {
        const { getDestination } = await import('@sap-cloud-sdk/connectivity');
        const destination = await getDestination({ destinationName: this.destinationName });
        
        if (destination) {
          console.log('[SharePoint] Using BTP Destination');
          return {
            useDestination: true,
            destination,
            driveId: destination.originalProperties?.driveId || process.env.GRAPH_DRIVE_ID,
            folderItemId: destination.originalProperties?.folderItemId || process.env.GRAPH_FOLDER_ID
          };
        }
      } catch (e) {
        console.warn('[SharePoint] Destination not available, falling back to env vars:', e.message);
      }
    }
    
    // Fallback to environment variables (local development)
    console.log('[SharePoint] Using environment variables');
    return {
      useDestination: false,
      tenantId: process.env.GRAPH_TENANT_ID,
      clientId: process.env.GRAPH_CLIENT_ID,
      clientSecret: process.env.GRAPH_CLIENT_SECRET,
      driveId: process.env.GRAPH_DRIVE_ID || 'b!ONJaTXThrUSlIF7Q4Wx2m4YsdEQF1mlDvlvUMMvUsMg2mQ75FZwDSYW6p_xyGQV_',
      folderItemId: process.env.GRAPH_FOLDER_ID || '01EYS6Y2JYBEFXDYCSRRHKGP5H4U2TBLN3'
    };
  }

  /**
   * Get OAuth2 access token (with caching)
   */
  async getAccessToken(config) {
    // Check if we have a valid cached token
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
    
    console.log('[SharePoint] Requesting new access token...');
    
    const response = await axios.post(tokenUrl, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000
    });
    
    // Cache token (expire 5 minutes early to be safe)
    this._accessToken = response.data.access_token;
    this._tokenExpiry = Date.now() + ((response.data.expires_in - 300) * 1000);
    
    console.log('[SharePoint] Access token obtained, expires in', response.data.expires_in, 'seconds');
    return this._accessToken;
  }

  /**
   * Execute Microsoft Graph API request
   */
  async executeGraphRequest(path, options = {}) {
    const config = await this.getConfig();
    const axios = require('axios');
    
    let headers = {
      'Content-Type': 'application/json',
      ...options.headers
    };
    
    // Get auth header
    if (config.useDestination) {
      // Use SAP Cloud SDK for destination-based auth
      try {
        const { executeHttpRequest } = await import('@sap-cloud-sdk/http-client');
        const response = await executeHttpRequest(
          { destinationName: this.destinationName },
          {
            method: options.method || 'GET',
            url: path,
            headers: options.headers,
            responseType: options.responseType
          }
        );
        return response;
      } catch (e) {
        console.error('[SharePoint] Cloud SDK request failed:', e.message);
        throw e;
      }
    }
    
    // Use axios with manual token
    const token = await this.getAccessToken(config);
    headers['Authorization'] = `Bearer ${token}`;
    
    const response = await axios({
      method: options.method || 'GET',
      url: `https://graph.microsoft.com${path}`,
      headers,
      responseType: options.responseType || 'json',
      timeout: options.timeout || 30000
    });
    
    return response;
  }

  /**
   * Map Graph file response to our CDS type
   */
  mapFileResponse(item) {
    return {
      itemId: item.id,
      name: item.name,
      size: item.size || 0,
      mimeType: item.file?.mimeType || 'application/octet-stream',
      webUrl: item.webUrl,
      createdAt: item.createdDateTime ? new Date(item.createdDateTime) : null,
      modifiedAt: item.lastModifiedDateTime ? new Date(item.lastModifiedDateTime) : null
    };
  }

  /**
   * Handler: List files in configured folder
   */
  async handleListFiles(req) {
    try {
      const config = await this.getConfig();
      const driveId = config.driveId;
      const folderId = config.folderItemId;
      
      if (!driveId || !folderId) {
        return req.error(500, 'Missing driveId or folderItemId in configuration');
      }
      
      const graphPath = `/v1.0/drives/${driveId}/items/${folderId}/children`;
      console.log(`[SharePoint] Listing files: ${graphPath}`);
      
      const response = await this.executeGraphRequest(graphPath);
      const items = response.data?.value || [];
      
      // Filter only files (not folders)
      const files = items
        .filter(item => item.file)
        .map(item => this.mapFileResponse(item));
      
      console.log(`[SharePoint] Found ${files.length} files`);
      return files;
      
    } catch (error) {
      console.error('[SharePoint] Error listing files:', error.message);
      return req.error(500, `Failed to list SharePoint files: ${error.message}`);
    }
  }

  /**
   * Handler: List files in specific folder
   */
  async handleListFilesInFolder(req) {
    try {
      const { folderId } = req.data;
      const config = await this.getConfig();
      const driveId = config.driveId;
      
      if (!driveId) {
        return req.error(500, 'Missing driveId in configuration');
      }
      
      const graphPath = `/v1.0/drives/${driveId}/items/${folderId}/children`;
      console.log(`[SharePoint] Listing files in folder: ${folderId}`);
      
      const response = await this.executeGraphRequest(graphPath);
      const items = response.data?.value || [];
      
      const files = items
        .filter(item => item.file)
        .map(item => this.mapFileResponse(item));
      
      return files;
      
    } catch (error) {
      console.error('[SharePoint] Error listing folder:', error.message);
      return req.error(500, `Failed to list folder: ${error.message}`);
    }
  }

  /**
   * Handler: Download file (streaming)
   */
  async handleDownloadFile(req) {
    try {
      const { itemId } = req.data;
      const config = await this.getConfig();
      const driveId = config.driveId;
      
      if (!driveId || !itemId) {
        return req.error(400, 'Missing driveId or itemId');
      }
      
      // Get file metadata first
      const metaPath = `/v1.0/drives/${driveId}/items/${itemId}`;
      const metaResponse = await this.executeGraphRequest(metaPath);
      const fileInfo = metaResponse.data;
      
      const fileName = fileInfo.name;
      const mimeType = fileInfo.file?.mimeType || 'application/octet-stream';
      const downloadUrl = fileInfo['@microsoft.graph.downloadUrl'];
      
      console.log(`[SharePoint] Downloading: ${fileName} (${mimeType})`);
      
      // Stream the file
      const axios = require('axios');
      let fileStream;
      
      if (downloadUrl) {
        // Use pre-authenticated download URL (no token needed, better performance)
        const downloadResponse = await axios({
          method: 'GET',
          url: downloadUrl,
          responseType: 'stream',
          timeout: 300000 // 5 min timeout for large files
        });
        fileStream = downloadResponse.data;
      } else {
        // Fallback: use Graph content endpoint
        const contentPath = `/v1.0/drives/${driveId}/items/${itemId}/content`;
        const contentResponse = await this.executeGraphRequest(contentPath, {
          responseType: 'stream'
        });
        fileStream = contentResponse.data;
      }
      
      // Set response headers
      const res = req._.res || req.res;
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
      
      if (fileInfo.size) {
        res.setHeader('Content-Length', fileInfo.size);
      }
      
      // Pipe stream to response
      return new Promise((resolve, reject) => {
        fileStream.pipe(res);
        fileStream.on('end', () => {
          console.log(`[SharePoint] Download complete: ${fileName}`);
          resolve();
        });
        fileStream.on('error', (err) => {
          console.error(`[SharePoint] Stream error: ${err.message}`);
          reject(err);
        });
      });
      
    } catch (error) {
      console.error('[SharePoint] Download error:', error.message);
      return req.error(500, `Download failed: ${error.message}`);
    }
  }

  /**
   * Handler: Get download URL (for UI direct download)
   */
  async handleGetDownloadUrl(req) {
    try {
      const { itemId } = req.data;
      const config = await this.getConfig();
      const driveId = config.driveId;
      
      if (!driveId || !itemId) {
        return req.error(400, 'Missing driveId or itemId');
      }
      
      const graphPath = `/v1.0/drives/${driveId}/items/${itemId}`;
      const response = await this.executeGraphRequest(graphPath);
      const downloadUrl = response.data['@microsoft.graph.downloadUrl'];
      
      if (!downloadUrl) {
        return req.error(404, 'Download URL not available for this file');
      }
      
      // URL is valid for approximately 1 hour
      const expiresAt = new Date(Date.now() + 3600000);
      
      return { url: downloadUrl, expiresAt };
      
    } catch (error) {
      console.error('[SharePoint] GetDownloadUrl error:', error.message);
      return req.error(500, `Failed to get download URL: ${error.message}`);
    }
  }

  /**
   * Handler: Create job from SharePoint file
   * Downloads file to temp directory and creates a processing job
   */
  async handleCreateJobFromSharePoint(req) {
    try {
      const { itemId, fileName } = req.data;
      const config = await this.getConfig();
      const driveId = config.driveId;
      
      if (!driveId || !itemId) {
        return req.error(400, 'Missing driveId or itemId');
      }
      
      console.log(`[SharePoint] Creating job from SharePoint file: ${fileName}`);
      
      // Get file metadata and download URL
      const metaPath = `/v1.0/drives/${driveId}/items/${itemId}`;
      const metaResponse = await this.executeGraphRequest(metaPath);
      const fileInfo = metaResponse.data;
      const downloadUrl = fileInfo['@microsoft.graph.downloadUrl'];
      
      if (!downloadUrl) {
        return req.error(404, 'Download URL not available');
      }
      
      // Create temp directory if it doesn't exist
      const tempDir = path.join(process.cwd(), 'temp_sharepoint');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      // Download file to temp directory
      const localFilePath = path.join(tempDir, fileName);
      const axios = require('axios');
      
      console.log(`[SharePoint] Downloading to: ${localFilePath}`);
      
      const downloadResponse = await axios({
        method: 'GET',
        url: downloadUrl,
        responseType: 'stream',
        timeout: 300000
      });
      
      // Write to file
      const writer = fs.createWriteStream(localFilePath);
      downloadResponse.data.pipe(writer);
      
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
      
      console.log(`[SharePoint] File downloaded: ${localFilePath}`);
      
      // Get FileProcService to create the job
      const FileProcService = await cds.connect.to('FileProcService');
      
      // Create job using the FileProcService
      const job = await FileProcService.send('createJob', {
        fileName: fileName,
        filePath: localFilePath
      });
      
      if (job && job.ID) {
        // Start processing
        await FileProcService.send('startProcessing', { jobId: job.ID });
        console.log(`[SharePoint] Job created and started: ${job.ID}`);
        return job.ID;
      }
      
      return req.error(500, 'Failed to create job');
      
    } catch (error) {
      console.error('[SharePoint] CreateJobFromSharePoint error:', error.message);
      return req.error(500, `Failed to create job from SharePoint: ${error.message}`);
    }
  }
};
