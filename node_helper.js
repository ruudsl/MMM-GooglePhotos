const NodeHelper = require("node_helper");
const GPhotosPicker = require("./GPhotosPicker.js");
const GPhotos = require("./GPhotos.js");
const { shuffle } = require("./shuffle.js");

const authOption = require("./google_auth.json");

module.exports = NodeHelper.create({
  start: function () {
    this.picker = null;
    this.gphotos = null;
    this.config = null;
    this.mediaItems = [];
    this.sessionId = null;
    this.sessionReady = false;
    this.baseUrlRefreshTimer = null;
    this.accessToken = null;
    this.mode = null; // "album" or "picker"
    this.matchedAlbums = [];
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
        if (this.mode === "album" && this.mediaItems.length > 0) {
          this.sendPhotos();
        } else if (this.sessionReady && this.mediaItems.length > 0) {
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
    // Determine mode: if albums are configured, use Library API; otherwise use Picker API
    const albums = this.config.albums;
    if (albums && Array.isArray(albums) && albums.length > 0) {
      this.mode = "album";
      await this.initializeAlbumMode();
    } else {
      this.mode = "picker";
      await this.initializePickerMode();
    }
  },

  // ─── Album Mode (Library API) ────────────────────────────────────────────

  initializeAlbumMode: async function () {
    try {
      this.gphotos = new GPhotos({
        authOption: authOption,
        debug: this.config.debug || false,
      });

      this.log("Album mode: fetching album list from Google Photos...");
      const albums = await this.gphotos.getAlbums();
      this.log("Found", albums.length, "albums in Google Photos.");

      this.matchedAlbums = this.matchAlbums(albums, this.config.albums);

      if (this.matchedAlbums.length === 0) {
        const albumNames = albums.map((a) => a.title).join(", ");
        this.logError("No matching albums found.");
        this.sendSocketNotification(
          "ERROR",
          "No matching albums found. Available albums: " + albumNames,
        );
        return;
      }

      this.log(
        "Matched albums:",
        this.matchedAlbums.map((a) => a.title).join(", "),
      );
      this.sendSocketNotification(
        "INITIALIZED",
        this.matchedAlbums.map((a) => ({
          id: a.id,
          title: a.title,
          count: a.mediaItemsCount,
        })),
      );

      await this.fetchAlbumPhotos();
      this.startAlbumBaseUrlRefresh();
    } catch (err) {
      this.logError("Album mode initialization error:", err.toString());
      this.sendSocketNotification(
        "ERROR",
        "Failed to load albums. Make sure your google_auth.json scope is set to " +
          "https://www.googleapis.com/auth/photoslibrary.readonly and regenerate " +
          "your token with: node generate_token_v2.js\n\nError: " +
          err.toString(),
      );
      // Retry after 5 minutes
      setTimeout(() => {
        this.config = null;
        this.initialize();
      }, 5 * 60 * 1000);
    }
  },

  matchAlbums: function (allAlbums, configAlbums) {
    const matched = [];
    for (const album of allAlbums) {
      for (const ca of configAlbums) {
        let isMatch = false;
        if (typeof ca === "string") {
          isMatch = album.title === ca;
        } else if (ca && ca.source) {
          // Regex (serialized from frontend as {source, flags})
          const regex = new RegExp(ca.source, ca.flags || "");
          isMatch = regex.test(album.title);
        }
        if (isMatch) {
          matched.push(album);
          break;
        }
      }
    }
    return matched;
  },

  isValidPhoto: function (item) {
    if (!item.mediaMetadata) return false;
    // Skip videos
    if (item.mediaMetadata.video) return false;

    const c = this.config.condition;
    if (!c) return true;

    const meta = item.mediaMetadata;
    const w = parseInt(meta.width) || 0;
    const h = parseInt(meta.height) || 0;

    if (c.minWidth && w < c.minWidth) return false;
    if (c.maxWidth && w > c.maxWidth) return false;
    if (c.minHeight && h < c.minHeight) return false;
    if (c.maxHeight && h > c.maxHeight) return false;

    if (w > 0 && h > 0) {
      const ratio = w / h;
      if (c.minWHRatio && ratio < c.minWHRatio) return false;
      if (c.maxWHRatio && ratio > c.maxWHRatio) return false;
    }

    if (c.fromDate || c.toDate) {
      const ct = new Date(meta.creationTime).getTime();
      if (c.fromDate && ct < new Date(c.fromDate).getTime()) return false;
      if (c.toDate && ct > new Date(c.toDate).getTime()) return false;
    }

    return true;
  },

  fetchAlbumPhotos: async function () {
    let allPhotos = [];
    for (const album of this.matchedAlbums) {
      try {
        const photos = await this.gphotos.getImageFromAlbum(album.id, (item) =>
          this.isValidPhoto(item),
        );
        this.log("Album '" + album.title + "':", photos.length, "photos");
        allPhotos = allPhotos.concat(photos);
      } catch (err) {
        this.logError(
          "Error fetching album '" + album.title + "':",
          err.toString(),
        );
      }
    }

    this.mediaItems = allPhotos;
    this.log("Total photos from albums:", this.mediaItems.length);

    if (this.mediaItems.length === 0) {
      this.sendSocketNotification(
        "ERROR",
        "No photos found in the selected albums.",
      );
      return;
    }

    this.sendPhotos();
  },

  startAlbumBaseUrlRefresh: function () {
    if (this.baseUrlRefreshTimer) clearInterval(this.baseUrlRefreshTimer);
    // Refresh every 50 minutes (Library API baseUrls expire after 60)
    this.baseUrlRefreshTimer = setInterval(async () => {
      this.log("Refreshing album photo baseUrls...");
      try {
        await this.fetchAlbumPhotos();
      } catch (err) {
        this.logError("Album baseUrl refresh error:", err.toString());
      }
    }, 50 * 60 * 1000);
  },

  // ─── Picker Mode (Picker API) ───────────────────────────────────────────

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
            await this.fetchAndSendPickerPhotos();
            this.startPickerBaseUrlRefresh();
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
        await this.fetchAndSendPickerPhotos();
        this.startPickerBaseUrlRefresh();
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

  fetchAndSendPickerPhotos: async function () {
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

  startPickerBaseUrlRefresh: function () {
    if (this.baseUrlRefreshTimer) clearInterval(this.baseUrlRefreshTimer);
    // Refresh every 50 minutes (baseUrls expire after 60)
    this.baseUrlRefreshTimer = setInterval(async () => {
      if (!this.sessionReady || !this.sessionId) return;
      this.log("Refreshing media item baseUrls...");
      try {
        await this.fetchAndSendPickerPhotos();
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

  // ─── Shared ──────────────────────────────────────────────────────────────

  sendPhotos: function () {
    if (this.mediaItems.length === 0) return;

    let photos;
    if (this.mode === "album") {
      // Library API format — baseUrl is directly on the item, no auth header needed
      photos = this.mediaItems.map((item) => ({
        id: item.id,
        baseUrl: item.baseUrl || "",
        mimeType: item.mimeType || "image/jpeg",
        mediaMetadata: item.mediaMetadata || {},
        _albumId: item._albumId || "unknown",
        // No _accessToken → frontend will use direct img.src loading
      }));
    } else {
      // Picker API format — requires auth header for baseUrl access
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

  log: function (...args) {
    console.log("[MMM-GooglePhotos]", ...args);
  },

  logError: function (...args) {
    console.error("[MMM-GooglePhotos]", ...args);
  },
});
