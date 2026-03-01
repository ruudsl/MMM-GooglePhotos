const NodeHelper = require("node_helper");
const fs = require("fs");
const path = require("path");
const GPhotosPicker = require("./GPhotosPicker.js");
const { shuffle } = require("./shuffle.js");

const authOption = require("./google_auth.json");

module.exports = NodeHelper.create({
  start: function () {
    this.picker = null;
    this.config = null;
    this.mediaItems = [];
    this.sessionId = null;
    this.sessionReady = false;
    this.baseUrlRefreshTimer = null;
    this.accessToken = null;
  },

  socketNotificationReceived: function (notification, payload) {
    switch (notification) {
      case "INIT":
        if (!this.config) {
          this.config = payload;
          this.initialize();
        }
        break;
      case "NEED_MORE_PICS":
        if (this.sessionReady && this.mediaItems.length > 0) {
          this.sendPhotos();
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
            this.log("Saved session still active, resuming poll for selection.");
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
          this.log("Saved session invalid or expired, creating new.", e.message || "");
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
        this.config = null;
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

  sendPhotos: function () {
    if (this.mediaItems.length === 0) return;

    // Transform to format the frontend expects
    const photos = this.mediaItems.map((item) => {
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
