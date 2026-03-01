"use strict";

const EventEmitter = require("events");
const fs = require("fs");
const path = require("path");
const { OAuth2Client } = require("google-auth-library");
const Axios = require("axios");
const { error_to_string } = require("./error_to_string");
const { ConfigFileError, AuthError } = require("./Errors");

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3/";

/**
 * Auth class - handles OAuth2 token lifecycle for Google Drive
 */
class Auth extends EventEmitter {
  #config;
  #debug;

  constructor(config, debug = false) {
    super();
    this.#config = config;
    this.#debug = debug;
    this.init().then(
      () => {},
      (err) => this.emit("error", err),
    );
  }

  async init() {
    const log = this.#debug
      ? (...args) => console.log("[GDRIVE:AUTH]", ...args)
      : () => {};

    if (!this.#config) this.#config = {};
    if (!this.#config.keyFilePath) {
      throw new ConfigFileError('Missing "keyFilePath" from config');
    }
    if (!this.#config.savedTokensPath) {
      throw new ConfigFileError('Missing "savedTokensPath" from config');
    }

    const tokenFile = path.resolve(__dirname, this.#config.savedTokensPath);
    if (!fs.existsSync(tokenFile)) {
      throw new AuthError(
        "No OAuth token found. Please run: node generate_token_v2.js",
      );
    }

    const credsFile = path.resolve(__dirname, this.#config.keyFilePath);
    if (!fs.existsSync(credsFile)) {
      throw new AuthError("Missing credentials.json file.");
    }

    const key = require(this.#config.keyFilePath).installed;
    const oauthClient = new OAuth2Client(
      key.client_id,
      key.client_secret,
      key.redirect_uris[0],
    );

    let tokensCred;

    const saveTokens = async (first = false) => {
      oauthClient.setCredentials(tokensCred);
      let expired = tokensCred.expiry_date < Date.now();
      if (expired) log("Token is expired.");

      if (expired || first) {
        const tk = await oauthClient.refreshAccessToken();
        tokensCred = tk.credentials;
        const tp = path.resolve(__dirname, this.#config.savedTokensPath);
        fs.mkdirSync(path.dirname(tp), { recursive: true });
        fs.writeFileSync(tp, JSON.stringify(tokensCred));
        log("Token is refreshed.");
        this.emit("ready", oauthClient);
      } else {
        log("Token is alive.");
        this.emit("ready", oauthClient);
      }
    };

    process.nextTick(() => {
      try {
        if (fs.existsSync(tokenFile)) {
          const data = fs.readFileSync(tokenFile);
          tokensCred = JSON.parse(data);
        }
      } catch (error) {
        console.error("[GDRIVE:AUTH]", error);
      } finally {
        if (tokensCred !== undefined) saveTokens();
      }
    });
  }
}

/**
 * GDrive - Google Drive API client for reading images from a folder
 *
 * Uses the Google Drive API v3 to list and serve images from a
 * specific folder. Fully automatic after initial OAuth setup.
 *
 * Scope required: https://www.googleapis.com/auth/drive.readonly
 */
class GDrive {
  constructor(options) {
    this.debug = options.debug || false;
    if (!options.authOption) {
      throw new Error("Invalid auth information.");
    }
    this.options = options;
    this._cachedClient = null;
    this._clientExpiry = 0;
  }

  log(...args) {
    console.info("[GDRIVE]", ...args);
  }

  logError(...args) {
    console.error("[GDRIVE]", ...args);
  }

  /**
   * Get an authenticated OAuth2Client.
   * Caches the client and reuses it until the token is close to expiry.
   * @returns {Promise<OAuth2Client>}
   */
  async onAuthReady() {
    if (this._cachedClient && Date.now() < this._clientExpiry - 120000) {
      return this._cachedClient;
    }

    let auth;
    try {
      auth = new Auth(this.options.authOption, this.debug);
    } catch (e) {
      this.log(e.toString());
      throw e;
    }
    const client = await new Promise((resolve, reject) => {
      auth.on("ready", (c) => resolve(c));
      auth.on("error", (error) => reject(error));
    });
    this._cachedClient = client;
    this._clientExpiry =
      client.credentials.expiry_date || Date.now() + 3600000;
    return client;
  }

  /**
   * Make an authenticated GET request to the Drive API
   */
  async request(token, endpoint, params = null) {
    try {
      const config = {
        method: "get",
        url: endpoint,
        baseURL: DRIVE_API_BASE,
        headers: {
          Authorization: "Bearer " + token,
        },
      };
      if (params) config.params = params;
      return await Axios(config);
    } catch (error) {
      this.logError("Request failed:", endpoint);
      this.logError(error_to_string(error));
      throw error;
    }
  }

  /**
   * Find a folder by name in Google Drive
   * @param {string} name folder name
   * @returns {Promise<string|null>} folder ID or null
   */
  async findFolderByName(name) {
    const client = await this.onAuthReady();
    const token = client.credentials.access_token;
    const response = await this.request(token, "files", {
      q:
        "name='" +
        name.replace(/'/g, "\\'") +
        "' and mimeType='application/vnd.google-apps.folder' and trashed=false",
      fields: "files(id,name)",
      pageSize: 10,
    });

    const folders = response.data.files || [];
    if (folders.length === 0) {
      return null;
    }
    if (folders.length > 1) {
      this.log(
        "Multiple folders named '" + name + "' found, using first match:",
        folders[0].id,
      );
    }
    return folders[0].id;
  }

  /**
   * Resolve a folder config value to a folder ID.
   * Accepts either a folder ID (long alphanumeric string) or a folder name.
   * @param {string} folderConfig
   * @returns {Promise<string>} folder ID
   */
  async resolveFolderId(folderConfig) {
    // If it looks like a Drive folder ID (typically 20+ chars, alphanumeric + dashes/underscores)
    if (/^[a-zA-Z0-9_-]{15,}$/.test(folderConfig)) {
      this.log("Using folder ID directly:", folderConfig);
      return folderConfig;
    }

    // Otherwise, search by name
    this.log("Searching for folder by name:", folderConfig);
    const folderId = await this.findFolderByName(folderConfig);
    if (!folderId) {
      throw new Error(
        "Google Drive folder '" +
          folderConfig +
          "' not found. Make sure the folder exists and is accessible.",
      );
    }
    this.log("Found folder ID:", folderId);
    return folderId;
  }

  /**
   * List all image files in a Google Drive folder
   * @param {string} folderId
   * @returns {Promise<Array>} array of file objects
   */
  async listImages(folderId) {
    const client = await this.onAuthReady();
    const token = client.credentials.access_token;
    let allFiles = [];
    let pageToken = null;

    do {
      const params = {
        q:
          "'" +
          folderId +
          "' in parents and mimeType contains 'image/' and trashed=false",
        fields:
          "nextPageToken,files(id,name,mimeType,createdTime,imageMediaMetadata)",
        pageSize: 100,
        orderBy: "createdTime desc",
      };
      if (pageToken) params.pageToken = pageToken;

      const response = await this.request(token, "files", params);
      const data = response.data;

      if (data.files && Array.isArray(data.files)) {
        allFiles = allFiles.concat(data.files);
      }

      pageToken = data.nextPageToken || null;
    } while (pageToken);

    this.log("Found", allFiles.length, "images in Drive folder.");
    return allFiles;
  }

  /**
   * Get the current access token for authenticated file downloads
   * @returns {Promise<string>}
   */
  async getAccessToken() {
    const client = await this.onAuthReady();
    return client.credentials.access_token;
  }
}

module.exports = GDrive;
