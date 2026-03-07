const NodeHelper = require("node_helper");
const fs = require("fs");
const path = require("path");
const GPhotosPicker = require("./GPhotosPicker.js");
const GDrive = require("./GDrive.js");
const { shuffle } = require("./shuffle.js");

const authOption = require("./google_auth.json");

module.exports = NodeHelper.create({
  start: function () {
    this.picker = null;
    this.drive = null;
    this.config = null;
    this.mediaItems = [];
    this.sessionId = null;
    this.sessionReady = false;
    this.baseUrlRefreshTimer = null;
    this.accessToken = null;
    this.mode = null; // "drive" or "picker"
    this.driveFolderId = null;
  },

  socketNotificationReceived: function (notification, payload) {
    switch (notification) {
      case "INIT":
        if (!this.config) {
          this.config = payload;
          this.initialize();
        } else if (
          JSON.stringify(this.config) !== JSON.stringify(payload)
        ) {
          this.log("Config changed, re-initializing...");
          if (this.baseUrlRefreshTimer) {
            clearInterval(this.baseUrlRefreshTimer);
            this.baseUrlRefreshTimer = null;
          }
          this.config = payload;
          this.mediaItems = [];
          this.mode = null;
          this.initialize();
        }
        break;
      case "NEED_MORE_PICS":
        if (this.mode === "drive" && this.mediaItems.length > 0) {
          this.sendPhotos();
        } else if (this.mode === "drive" && this.mediaItems.length === 0) {
          // Drive mode but no photos — try re-fetching from Drive
          this.log("No photos in cache, re-fetching from Drive...");
          this.fetchDrivePhotos().catch((err) => {
            this.logError("Re-fetch Drive photos failed:", err.toString());
          });
        } else if (this.sessionReady && this.mediaItems.length > 0) {
          this.sendPhotos();
        } else if (this.sessionReady && this.mediaItems.length === 0) {
          // Picker mode, session ready but no photos — try re-fetching
          this.log("No photos in cache, re-fetching from Picker session...");
          this.fetchAndSendPhotos().catch((err) => {
            this.logError("Re-fetch Picker photos failed:", err.toString());
          });
        } else {
          // Session not ready — notify frontend there are no photos yet
          this.log(
            "NEED_MORE_PICS received but session not ready (mode:",
            this.mode,
            ", sessionReady:",
            this.sessionReady,
            ", mediaItems:",
            this.mediaItems.length,
            ")",
          );
          this.sendSocketNotification("MORE_PICS", []);
        }
        break;
      case "IMAGE_LOADED":
        break;
      case "IMAGE_LOAD_FAIL":
        this.log("Image load failed:", payload?.url);
        break;
      case "MODULE_SUSPENDED_SKIP_UPDATE":
        break;
    }
  },

  initialize: async function () {
    this.log(
      "Initializing. driveFolder:",
      this.config.driveFolder || "(not set)",
    );
    if (this.config.driveFolder) {
      this.mode = "drive";
      await this.initializeDriveMode();
    } else {
      this.mode = "picker";
      await this.initializePickerMode();
    }
  },

  // ─── Drive Mode ──────────────────────────────────────────────────────────

  initializeDriveMode: async function () {
    try {
      this.drive = new GDrive({
        authOption: authOption,
        debug: this.config.debug || false,
      });

      this.log("Drive mode: resolving folder:", this.config.driveFolder);
      this.driveFolderId = await this.drive.resolveFolderId(
        this.config.driveFolder,
      );

      this.accessToken = await this.drive.getAccessToken();
      await this.fetchDrivePhotos();
      this.startDriveRefresh();
    } catch (err) {
      this.logError("Drive mode initialization error:", err.toString());
      this.sendSocketNotification(
        "ERROR",
        "Google Drive error: " +
          err.toString() +
          "\n\nMake sure google_auth.json has scope: " +
          "https://www.googleapis.com/auth/drive.readonly " +
          "and run: node generate_token_v2.js",
      );
      // Retry after 5 minutes
      setTimeout(() => {
        this.log("Retrying Drive mode initialization...");
        this.initialize();
      }, 5 * 60 * 1000);
    }
  },

  fetchDrivePhotos: async function () {
    const files = await this.drive.listImages(this.driveFolderId);

    this.mediaItems = files;
    this.accessToken = await this.drive.getAccessToken();

    if (this.mediaItems.length === 0) {
      this.sendSocketNotification(
        "ERROR",
        "No images found in Google Drive folder: " + this.config.driveFolder,
      );
      return;
    }

    this.log("Drive folder photos:", this.mediaItems.length);
    this.sendSocketNotification("INITIALIZED", []);
    this.sendPhotos();
  },

  startDriveRefresh: function () {
    if (this.baseUrlRefreshTimer) clearInterval(this.baseUrlRefreshTimer);
    // Refresh every 50 minutes (tokens expire after 60)
    this.baseUrlRefreshTimer = setInterval(async () => {
      this.log("Refreshing Drive photos and access token...");
      try {
        await this.fetchDrivePhotos();
      } catch (err) {
        this.logError("Drive refresh error:", err.toString());
      }
    }, 50 * 60 * 1000);
  },

  // ─── Picker Mode ─────────────────────────────────────────────────────────

  initializePickerMode: async function () {
    try {
      this.picker = new GPhotosPicker({
        authOption: authOption,
        debug: this.config.debug || false,
      });

      // Try to resume a saved session first
      const saved = this.picker.loadSavedSession();
      if (saved && saved.id) {
        this.log("Attempting to resume saved session:", saved.id);
        try {
          const session = await this.picker.getSession(saved.id);
          if (session.mediaItemsSet) {
            this.log("Saved session has photos ready!");
            this.sessionId = saved.id;
            this.sessionReady = true;
            await this.fetchAndSendPhotos();
            this.startBaseUrlRefresh();
            return;
          } else {
            // Session is still valid but user hasn't picked yet — resume polling
            this.log(
              "Saved session still active, resuming poll for selection.",
            );
            this.sessionId = saved.id;

            // Show the picker URI again so user can continue selecting
            if (saved.pickerUri) {
              this.sendSocketNotification("PICKER_SESSION", {
                pickerUri: saved.pickerUri,
                sessionId: saved.id,
              });
            }

            this.pollForSelection();
            return;
          }
        } catch (e) {
          this.log(
            "Saved session invalid or expired, creating new.",
            e.message || "",
          );
          this.picker.clearSession();
        }
      }

      // No valid saved session — create a new one
      await this.createNewSession();
    } catch (err) {
      this.logError("Initialization error:", err.toString());
      this.sendSocketNotification("ERROR", err.toString());
      // Retry after 5 minutes
      setTimeout(() => {
        this.log("Retrying Picker mode initialization...");
        this.initialize();
      }, 5 * 60 * 1000);
    }
  },

  createNewSession: async function () {
    try {
      const session = await this.picker.createSession();
      this.sessionId = session.id;
      this.sessionReady = false;

      // Tell the frontend to show the picker URI
      this.sendSocketNotification("PICKER_SESSION", {
        pickerUri: session.pickerUri,
        sessionId: session.id,
      });

      this.log("Picker session created. Waiting for user to select photos...");
      this.log("Picker URI:", session.pickerUri);

      // Start polling for user selection
      this.pollForSelection();
    } catch (err) {
      this.logError("Failed to create picker session:", err.toString());
      this.sendSocketNotification(
        "ERROR",
        "Failed to create photo picker session: " + err.toString(),
      );
    }
  },

  pollForSelection: async function () {
    try {
      const ready = await this.picker.pollSession(
        this.sessionId,
        (status) => {
          this.sendSocketNotification("UPDATE_STATUS", status);
        },
      );

      if (ready) {
        this.sessionReady = true;
        this.sendSocketNotification("CLEAR_ERROR");
        await this.fetchAndSendPhotos();
        this.startBaseUrlRefresh();
      } else {
        this.log("Picker session timed out. Creating new session...");
        this.picker.clearSession();
        await this.createNewSession();
      }
    } catch (err) {
      this.logError("Poll error:", err.toString());
      this.sendSocketNotification(
        "ERROR",
        "Error waiting for photo selection: " + err.toString(),
      );
      setTimeout(() => this.pollForSelection(), 2 * 60 * 1000);
    }
  },

  fetchAndSendPhotos: async function () {
    try {
      const items = await this.picker.listMediaItems(this.sessionId);

      // Filter to images only
      this.mediaItems = items.filter(
        (item) =>
          item.type === "PHOTO" ||
          (item.mediaFile &&
            item.mediaFile.mimeType &&
            item.mediaFile.mimeType.startsWith("image/")),
      );

      if (this.mediaItems.length === 0) {
        this.sendSocketNotification(
          "ERROR",
          "No photos found in selection. Please select some photos.",
        );
        return;
      }

      this.accessToken = await this.picker.getAccessToken();
      this.log("Total photos available:", this.mediaItems.length);
      this.sendSocketNotification("INITIALIZED", []);
      this.sendPhotos();
    } catch (err) {
      this.logError("Fetch photos error:", err.toString());
      this.sendSocketNotification(
        "ERROR",
        "Failed to retrieve photos: " + err.toString(),
      );
    }
  },

  // ─── Shared ──────────────────────────────────────────────────────────────

  sendPhotos: function () {
    if (this.mediaItems.length === 0) return;

    let photos;
    if (this.mode === "drive") {
      photos = this.mediaItems.map((file) => ({
        id: file.id,
        baseUrl:
          "https://www.googleapis.com/drive/v3/files/" +
          file.id +
          "?alt=media",
        mimeType: file.mimeType || "image/jpeg",
        mediaMetadata: {
          creationTime: file.createdTime || new Date().toISOString(),
          width:
            (file.imageMediaMetadata && file.imageMediaMetadata.width) ||
            "1920",
          height:
            (file.imageMediaMetadata && file.imageMediaMetadata.height) ||
            "1080",
        },
        _driveMode: true,
        _accessToken: this.accessToken,
      }));
    } else {
      photos = this.mediaItems.map((item) => {
        const mediaFile = item.mediaFile || {};
        return {
          id: item.id,
          baseUrl: mediaFile.baseUrl || "",
          mimeType: mediaFile.mimeType || "image/jpeg",
          mediaMetadata: {
            creationTime: item.createTime || new Date().toISOString(),
            width: mediaFile.mediaFileMetadata?.width || "1920",
            height: mediaFile.mediaFileMetadata?.height || "1080",
          },
          _albumId: "picker",
          _accessToken: this.accessToken,
        };
      });
    }

    let sorted;
    if (this.config.sort === "random") {
      sorted = shuffle([...photos]);
    } else if (this.config.sort === "old") {
      sorted = [...photos].sort(
        (a, b) =>
          new Date(a.mediaMetadata.creationTime) -
          new Date(b.mediaMetadata.creationTime),
      );
    } else {
      sorted = [...photos].sort(
        (a, b) =>
          new Date(b.mediaMetadata.creationTime) -
          new Date(a.mediaMetadata.creationTime),
      );
    }

    this.sendSocketNotification("MORE_PICS", sorted);
  },

  startBaseUrlRefresh: function () {
    if (this.baseUrlRefreshTimer) clearInterval(this.baseUrlRefreshTimer);
    // Refresh every 50 minutes (baseUrls expire after 60)
    this.baseUrlRefreshTimer = setInterval(async () => {
      if (!this.sessionReady || !this.sessionId) return;
      this.log("Refreshing media item baseUrls...");
      try {
        await this.fetchAndSendPhotos();
      } catch (err) {
        this.logError("BaseUrl refresh error:", err.toString());
        // Check if the session itself is still valid before nuking it
        try {
          const session = await this.picker.getSession(this.sessionId);
          if (session && session.mediaItemsSet) {
            this.log("Session still valid, will retry refresh next cycle.");
            return; // Keep session, retry on next interval
          }
        } catch (checkErr) {
          this.logError("Session check also failed:", checkErr.toString());
        }
        // Only create new session if the old one is truly dead
        this.log("Session appears expired. Creating new picker session...");
        this.picker.clearSession();
        this.sessionReady = false;
        await this.createNewSession();
      }
    }, 50 * 60 * 1000);
  },

  log: function (...args) {
    console.log("[MMM-GooglePhotos]", ...args);
  },

  logError: function (...args) {
    console.error("[MMM-GooglePhotos]", ...args);
  },
});
