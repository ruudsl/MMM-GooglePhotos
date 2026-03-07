//
//
// MMM-GooglePhotos
//
Module.register("MMM-GooglePhotos", {
  defaults: {
    albums: [],
    driveFolder: null, // Google Drive folder name or ID (enables Drive mode)
    updateInterval: 60000, // 60 seconds
    sort: "random", // random, time
    maxWidth: 1920,
    maxHeight: 1080,
    condition: {
      fromDate: null, // Or "2018-03", RFC ... format available
      toDate: null, // Or "2019-12-25",
      minWidth: null, // Or 400
      maxWidth: null, // Or 8000
      minHeight: null, // Or 400
      maxHeight: null, // Or 8000
      minWHRatio: null,
      maxWHRatio: null,
      // WHRatio = Width/Height ratio ( ==1 : Squared Photo,   < 1 : Portraited Photo, > 1 : Landscaped Photo)
    },
    showWidth: 1080, // These values will be used for quality of downloaded photos to show. real size to show in your MagicMirror region is recommended.
    showHeight: 1920,
    timeFormat: "YYYY/MM/DD HH:mm",
    autoInfoPosition: false,
  },
  requiresVersion: "2.24.0",

  suspended: false,

  getStyles: function () {
    return ["MMM-GooglePhotos.css"];
  },

  start: function () {
    this.currentPhoto = null;
    this.uploadableAlbum = null;
    this.albums = null;
    this.scanned = [];
    this.updateTimer = null;
    this.index = 0;
    this.needMorePicsFlag = true;
    this.firstScan = true;
    if (this.config.updateInterval < 1000 * 10) this.config.updateInterval = 1000 * 10;
    this.config.condition = Object.assign({}, this.defaults.condition, this.config.condition);

    const config = { ...this.config };
    for (let i = 0; i < config.albums.length; i++) {
      const album = config.albums[i];
      if (album instanceof RegExp) {
        config.albums[i] = {
          source: album.source,
          flags: album.flags,
        };
      }
    }

    this.sendSocketNotification("INIT", config);
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification === "UPLOADABLE_ALBUM") {
      this.uploadableAlbum = payload;
    }
    if (notification === "PICKER_SESSION") {
      // Show picker URI for user to select photos, with optional album hints
      this.showPickerPrompt(payload.pickerUri, this.config.albums);
    }
    if (notification === "INITIALIZED") {
      this.albums = payload;
      if (!this.updateTimer || this.updateTimer === null) {
        Log.info("Start timer for updating photos.");
        this.updateTimer = setInterval(() => {
          this.updatePhotos();
        }, this.config.updateInterval);
      }
    }
    if (notification === "UPDATE_ALBUMS") {
      this.albums = payload;
    }
    if (notification === "MORE_PICS") {
      if (payload && Array.isArray(payload) && payload.length > 0) this.needMorePicsFlag = false;
      this.scanned = payload;
      this.index = 0;
      if (this.firstScan) {
        this.updatePhotos();
      }
    }
    if (notification === "ERROR") {
      const current = document.getElementById("GPHOTO_CURRENT");
      if (current) {
        current.textContent = "";
        const errMsgDiv = document.createElement("div");
        errMsgDiv.style.textAlign = "center";
        errMsgDiv.style.lineHeight = "80vh";
        errMsgDiv.style.fontSize = "1.5em";
        errMsgDiv.style.verticalAlign = "middle";
        errMsgDiv.textContent = payload;
        current.appendChild(errMsgDiv);
      }
    }
    if (notification === "CLEAR_ERROR") {
      const current = document.getElementById("GPHOTO_CURRENT");
      if (current) current.textContent = "";
    }
    if (notification === "UPDATE_STATUS") {
      // Update status in the picker prompt area if visible, otherwise info bar
      let statusEl = document.getElementById("GPHOTO_PICKER_STATUS");
      if (statusEl) {
        statusEl.textContent = String(payload);
      } else {
        let info = document.getElementById("GPHOTO_INFO");
        if (info) info.innerHTML = String(payload);
      }
    }
  },

  notificationReceived: function (noti, payload, sender) {
    if (noti === "GPHOTO_NEXT") {
      this.updatePhotos();
    }
    if (noti === "GPHOTO_PREVIOUS") {
      this.updatePhotos(-2);
    }
    if (noti === "GPHOTO_UPLOAD") {
      this.sendSocketNotification("UPLOAD", payload);
    }
  },

  updatePhotos: function (dir = 0) {
    Log.debug("Updating photos..");
    this.firstScan = false;

    if (this.scanned.length === 0) {
      this.sendSocketNotification("NEED_MORE_PICS", []);
      // Retry after 30 seconds if still no photos
      if (!this._emptyRetryTimer) {
        this._emptyRetryTimer = setTimeout(() => {
          this._emptyRetryTimer = null;
          if (this.scanned.length === 0) {
            Log.warn("Still no photos available, retrying...");
            this.sendSocketNotification("NEED_MORE_PICS", []);
          }
        }, 30000);
      }
      return;
    }
    if (this.suspended) {
      this.sendSocketNotification("MODULE_SUSPENDED_SKIP_UPDATE");
      let info = document.getElementById("GPHOTO_INFO");
      info.innerHTML = "";
      return;
    }
    this.index = this.index + dir; //only used for reversing
    if (this.index < 0) this.index = this.scanned.length + this.index;
    if (this.index >= this.scanned.length) {
      this.index -= this.scanned.length;
    }
    let target = this.scanned[this.index];
    let url = target._driveMode
      ? target.baseUrl
      : target.baseUrl + `=w${this.config.showWidth}-h${this.config.showHeight}`;
    this.ready(url, target);
    this.index++;
    if (this.index >= this.scanned.length) {
      this.index = 0;
      this.needMorePicsFlag = true;
    }
    if (this.needMorePicsFlag) {
      setTimeout(() => {
        this.sendSocketNotification("NEED_MORE_PICS", []);
      }, 2000);
    }
  },

  _scheduleRetryNext: function () {
    // Skip to the next photo after a short delay when current one fails to load
    this._consecutiveFailures = (this._consecutiveFailures || 0) + 1;
    if (this._consecutiveFailures >= 5) {
      // Too many failures in a row — URLs likely expired, request fresh photos
      Log.warn("Multiple consecutive image load failures, requesting fresh photos...");
      this._consecutiveFailures = 0;
      this.needMorePicsFlag = true;
      this.sendSocketNotification("NEED_MORE_PICS", []);
      return;
    }
    // Try the next photo after 3 seconds
    if (!this._retryNextTimer) {
      this._retryNextTimer = setTimeout(() => {
        this._retryNextTimer = null;
        this.updatePhotos();
      }, 3000);
    }
  },

  showPickerPrompt: function (pickerUri, albums) {
    const current = document.getElementById("GPHOTO_CURRENT");
    if (!current) return;
    current.textContent = "";
    const prompt = document.createElement("div");
    prompt.style.textAlign = "center";
    prompt.style.padding = "20px";

    // Build album search hint if albums are configured
    let albumHint = "";
    if (albums && Array.isArray(albums) && albums.length > 0) {
      const albumNames = albums
        .map((a) => (typeof a === "string" ? a : a.source || ""))
        .filter((n) => n.length > 0);
      if (albumNames.length > 0) {
        const namesHtml = albumNames
          .map((n) => "<strong>" + n + "</strong>")
          .join(", ");
        albumHint =
          '<div style="margin-top:12px; font-size:0.85em; color:#aaa; ' +
          'background:rgba(255,255,255,0.05); padding:10px; border-radius:8px;">' +
          "Search for album: " +
          namesHtml +
          "<br>" +
          '<span style="font-size:0.85em; color:#777;">Use the search bar in the picker to find your album, then select all photos.</span>' +
          "</div>";
      }
    }

    prompt.innerHTML =
      '<div style="font-size:1.3em; margin-bottom:15px;">Select your photos</div>' +
      '<div style="font-size:0.9em; margin-bottom:15px;">Open this link on your phone or computer to choose photos:</div>' +
      '<a href="' +
      pickerUri +
      '" target="_blank" style="color:#4fc3f7; word-break:break-all; font-size:0.8em;">' +
      pickerUri +
      "</a>" +
      albumHint +
      '<div style="margin-top:10px; font-size:0.8em; color:#aaa;">After selecting photos, click <strong>Done</strong> in the Google Photos picker.</div>' +
      '<div id="GPHOTO_PICKER_STATUS" style="margin-top:15px; font-size:0.75em; color:#888;">Waiting for photo selection...</div>';
    current.appendChild(prompt);
  },

  ready: function (url, target) {
    // Picker API baseUrls require an Authorization header,
    // so we use fetch() + createObjectURL instead of direct img.src
    if (target._accessToken) {
      const _this = this;
      fetch(url, {
        headers: { Authorization: "Bearer " + target._accessToken },
      })
        .then((res) => {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.blob();
        })
        .then((blob) => {
          const objectUrl = URL.createObjectURL(blob);
          _this.render(objectUrl, target);
        })
        .catch((err) => {
          Log.error("Image fetch error:", err);
          _this.sendSocketNotification("IMAGE_LOAD_FAIL", { url });
          // Skip to next photo instead of staying on broken image
          _this._scheduleRetryNext();
        });
    } else {
      // Fallback: direct load (Library API style)
      let hidden = document.createElement("img");
      const _this = this;
      hidden.onerror = () => {
        _this.sendSocketNotification("IMAGE_LOAD_FAIL", { url });
        // Skip to next photo instead of staying on broken image
        _this._scheduleRetryNext();
      };
      hidden.onload = () => {
        _this.render(url, target);
      };
      hidden.src = url;
    }
  },

  render: function (url, target) {
    this._consecutiveFailures = 0; // Reset on successful load
    let back = document.getElementById("GPHOTO_BACK");
    let current = document.getElementById("GPHOTO_CURRENT");
    if (!current || !back) return;
    current.textContent = "";
    back.style.backgroundImage = `url(${url})`;
    current.style.backgroundImage = `url(${url})`;
    current.classList.add("animated");
    const info = document.getElementById("GPHOTO_INFO");
    if (!info) return;

    if (this.config.autoInfoPosition) {
      let op = () => {
        let now = new Date();
        let q = Math.floor(now.getMinutes() / 15);
        let r = [
          [0, "none", "none", 0],
          ["none", "none", 0, 0],
          ["none", 0, 0, "none"],
          [0, 0, "none", "none"],
        ];
        return r[q];
      };
      if (typeof this.config.autoInfoPosition === "function") {
        op = this.config.autoInfoPosition;
      }
      const [top, left, bottom, right] = op({}, target);
      info.style.setProperty("--top", top);
      info.style.setProperty("--left", left);
      info.style.setProperty("--bottom", bottom);
      info.style.setProperty("--right", right);
    }

    info.innerHTML = "";
    let photoTime = document.createElement("div");
    photoTime.classList.add("photoTime");
    if (target.mediaMetadata && target.mediaMetadata.creationTime) {
      photoTime.innerHTML =
        this.config.timeFormat === "relative"
          ? moment(target.mediaMetadata.creationTime).fromNow()
          : moment(target.mediaMetadata.creationTime).format(this.config.timeFormat);
    }
    let infoText = document.createElement("div");
    infoText.classList.add("infoText");
    infoText.appendChild(photoTime);
    info.appendChild(infoText);
    this.sendSocketNotification("IMAGE_LOADED", { id: target.id, index: this.index });
  },

  getDom: function () {
    let dom = document.createElement("div");
    dom.id = "GPHOTO";
    dom.style.width = this.config.showWidth + "px";
    dom.style.height = this.config.showHeight + "px";
    let back = document.createElement("div");
    back.id = "GPHOTO_BACK";
    let current = document.createElement("div");
    current.id = "GPHOTO_CURRENT";
    let info = document.createElement("div");
    info.id = "GPHOTO_INFO";
    dom.appendChild(back);
    dom.appendChild(current);
    dom.appendChild(info);
    return dom;
  },

  suspend() {
    this.suspended = true;
  },

  resume() {
    this.suspended = false;
  },
});
