/* ============================================================================
 * Motor Mumble + WebSocket HTTPS/443 para Conferencias en Conexiones Lentas
 * Sustituye el SDK WebRTC de LiveKit por un único túnel WebSocket (puerto 443)
 * con voz ultraligera (µ-law + VAD) y video 240p exclusivo para Asiento 1 y
 * La Palabra, sin requerir UDP, STUN ni TURN.
 * ============================================================================ */
(function () {
  'use strict';

  const FRAME_AUDIO = 0x01;
  const FRAME_VIDEO = 0x02;
  const FRAME_SCREEN = 0x03;
  const FRAME_AUDIO_SHARE = 0x04;

  const RoomEvent = {
    TrackSubscribed: 'TrackSubscribed',
    TrackUnsubscribed: 'TrackUnsubscribed',
    TrackMuted: 'TrackMuted',
    TrackUnmuted: 'TrackUnmuted',
    LocalTrackPublished: 'LocalTrackPublished',
    LocalTrackUnpublished: 'LocalTrackUnpublished',
    ParticipantPermissionsChanged: 'ParticipantPermissionsChanged',
    ParticipantConnected: 'ParticipantConnected',
    ParticipantDisconnected: 'ParticipantDisconnected',
    ConnectionStateChanged: 'ConnectionStateChanged',
    ConnectionQualityChanged: 'ConnectionQualityChanged',
    ActiveSpeakersChanged: 'ActiveSpeakersChanged',
    DataReceived: 'DataReceived',
    Disconnected: 'Disconnected',
  };

  const TrackSource = {
    Camera: 'camera',
    Microphone: 'microphone',
    ScreenShare: 'screen_share',
    ScreenShareAudio: 'screen_share_audio',
  };

  const ConnectionQuality = {
    Excellent: 'excellent',
    Good: 'good',
    Poor: 'poor',
    Lost: 'lost',
  };

  const DisconnectReason = {
    CLIENT_INITIATED: 1,
    DUPLICATE_IDENTITY: 2,
    PARTICIPANT_REMOVED: 4,
  };

  const VideoPresets = {
    h540: { resolution: { width: 320, height: 240 } },
  };

  const AudioPresets = {
    telephone: { maxBitrate: 12000 },
    speech: { maxBitrate: 20000 },
    musicStereo: { maxBitrate: 32000 },
  };

  // --- Tablas y conversión µ-law (G.711 u-law, 8 bits por muestra) ---
  const ulawDecodeTable = new Float32Array(256);
  (function initUlaw() {
    for (let i = 0; i < 256; i++) {
      let u = ~i & 0xff;
      let sign = u & 0x80;
      let exponent = (u >> 4) & 0x07;
      let mantissa = u & 0x0f;
      let sample = ((mantissa << 3) + 0x84) << exponent;
      sample -= 0x84;
      ulawDecodeTable[i] = (sign ? -sample : sample) / 32768.0;
    }
  })();

  function linearToUlaw(sampleFloat) {
    let s = Math.max(-1, Math.min(1, sampleFloat));
    let pcm = (s * 32767) | 0;
    let sign = (pcm >> 8) & 0x80;
    if (sign !== 0) pcm = -pcm;
    if (pcm > 32635) pcm = 32635;
    pcm += 0x84;
    let exponent = 7;
    for (let expMask = 0x4000; (pcm & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
    let mantissa = (pcm >> (exponent + 3)) & 0x0f;
    return ~(sign | (exponent << 4) | mantissa) & 0xff;
  }

  class Emitter {
    constructor() {
      this._handlers = new Map();
    }
    on(ev, fn) {
      if (!this._handlers.has(ev)) this._handlers.set(ev, new Set());
      this._handlers.get(ev).add(fn);
      return this;
    }
    off(ev, fn) {
      const set = this._handlers.get(ev);
      if (set) set.delete(fn);
      return this;
    }
    emit(ev, ...args) {
      const set = this._handlers.get(ev);
      if (!set) return;
      for (const fn of [...set]) {
        try { fn(...args); } catch (e) { console.error('RoomEvent error:', e); }
      }
    }
  }

  // --- Track remoto o local compatible con track.attach() / track.detach() ---
  class MediaTrack {
    constructor(kind, source, mediaStreamTrack) {
      this.kind = kind; // 'audio' | 'video'
      this.source = source;
      this.mediaStreamTrack = mediaStreamTrack || null;
      this._els = new Set();
      this._canvas = null;
      this._ctx2d = null;
    }

    attach() {
      if (this.kind === 'audio') {
        const el = document.createElement('audio');
        el.autoplay = true;
        el.playsInline = true;
        if (this.mediaStreamTrack) {
          el.srcObject = new MediaStream([this.mediaStreamTrack]);
        }
        this._els.add(el);
        return el;
      }
      // Video local (con mediaStreamTrack directo) vs. Video remoto por canvas/WebSocket
      const el = document.createElement('video');
      el.autoplay = true;
      el.muted = true;
      el.playsInline = true;
      if (this.mediaStreamTrack) {
        el.srcObject = new MediaStream([this.mediaStreamTrack]);
        el.play().catch(() => {});
      } else if (this._canvas && this._canvas.captureStream) {
        el.srcObject = this._canvas.captureStream(12);
        el.play().catch(() => {});
      }
      this._els.add(el);
      return el;
    }

    detach() {
      const out = [...this._els];
      this._els.clear();
      return out;
    }

    stop() {
      if (this.mediaStreamTrack) {
        if (this.mediaStreamTrack._rawStream) {
          try { this.mediaStreamTrack._rawStream.getTracks().forEach(t => t.stop()); } catch {}
        }
        if (this.mediaStreamTrack.stop) {
          try { this.mediaStreamTrack.stop(); } catch {}
        }
      }
    }

    async restartTrack(constraints) {
      if (this._onRestart) {
        return this._onRestart(constraints);
      }
    }
  }

  class TrackPublication {
    constructor(source, track, trackSid, trackName) {
      this.source = source;
      this.track = track;
      this.trackSid = trackSid || ('TR_' + Math.random().toString(36).slice(2, 10));
      this.trackName = trackName || source;
      this.isMuted = false;
      this._onMuteChange = null;
    }
    async mute() {
      this.isMuted = true;
      if (this._onMuteChange) this._onMuteChange(true);
    }
    async unmute() {
      this.isMuted = false;
      if (this._onMuteChange) this._onMuteChange(false);
    }
  }

  class Participant {
    constructor(identity, name, isLocal, room) {
      this.identity = identity || '';
      this.name = name || identity || '';
      this.isLocal = !!isLocal;
      this._room = room;
      this.pubs = new Map(); // source -> TrackPublication
      this.isSpeaking = false;
    }
    getTrackPublication(source) {
      return this.pubs.get(source) || null;
    }
    get isMicrophoneEnabled() {
      const p = this.pubs.get(TrackSource.Microphone);
      return !!(p && !p.isMuted && p.track);
    }
    get isCameraEnabled() {
      const p = this.pubs.get(TrackSource.Camera);
      return !!(p && !p.isMuted && p.track);
    }
    get isScreenShareEnabled() {
      const p = this.pubs.get(TrackSource.ScreenShare);
      return !!(p && !p.isMuted && p.track);
    }
  }

  class LocalParticipant extends Participant {
    constructor(room) {
      super('', '', true, room);
      this._micCleanup = null;
      this._camCleanup = null;
      this._scrCleanup = null;
      this._ashCleanup = null;
    }

    async publishData(uint8Payload) {
      if (!this._room || !this._room._ws || this._room._ws.readyState !== WebSocket.OPEN) return;
      const txt = new TextDecoder().decode(uint8Payload);
      this._room._ws.send(txt);
    }

    async publishTrack(mediaStreamTrack, opts = {}) {
      const source = opts.source || TrackSource.Microphone;
      const name = opts.name || source;

      if (source === TrackSource.Microphone) {
        if (this._micCleanup) this._micCleanup();
        const track = new MediaTrack('audio', source, mediaStreamTrack);
        const pub = new TrackPublication(source, track, 'TR_MIC_' + this.identity, name);
        pub._onMuteChange = (muted) => {
          this._room._enviarEstadoMedia();
          this._room.emit(muted ? RoomEvent.TrackMuted : RoomEvent.TrackUnmuted, pub, this);
        };
        this.pubs.set(source, pub);
        this._iniciarEnvioVozMumble(mediaStreamTrack, pub, opts);
        this._room._enviarEstadoMedia();
        this._room.emit(RoomEvent.LocalTrackPublished, pub, this);
        return pub;
      }

      if (source === TrackSource.ScreenShareAudio) {
        if (this._ashCleanup) this._ashCleanup();
        const track = new MediaTrack('audio', source, mediaStreamTrack);
        const pub = new TrackPublication(source, track, 'TR_ASH_' + this.identity, name);
        this.pubs.set(source, pub);
        this._iniciarEnvioAudioCompartido(mediaStreamTrack, pub, name);
        this._room.emit(RoomEvent.LocalTrackPublished, pub, this);
        return pub;
      }

      const track = new MediaTrack('video', source, mediaStreamTrack);
      const pub = new TrackPublication(source, track, 'TR_VID_' + this.identity, name);
      this.pubs.set(source, pub);
      this._room._enviarEstadoMedia();
      this._room.emit(RoomEvent.LocalTrackPublished, pub, this);
      return pub;
    }

    async unpublishTrack(track) {
      for (const [src, pub] of this.pubs.entries()) {
        if (pub.track === track || !track) {
          this.pubs.delete(src);
          if (src === TrackSource.Microphone && this._micCleanup) {
            this._micCleanup();
            this._micCleanup = null;
          }
          if (src === TrackSource.ScreenShareAudio && this._ashCleanup) {
            this._ashCleanup();
            this._ashCleanup = null;
          }
          this._room._enviarEstadoMedia();
          this._room.emit(RoomEvent.LocalTrackUnpublished, pub, this);
        }
      }
    }

    _iniciarEnvioVozMumble(mediaStreamTrack, pub, opts) {
      // Frecuencia de muestreo: 8000 Hz en perfil teléfono (~8 KB/s) o 12000 Hz en voz
      const maxBr = (opts && opts.audioPreset && opts.audioPreset.maxBitrate) || 16000;
      const targetRate = maxBr <= 12000 ? 8000 : 12000;
      let actx = null;
      let proc = null;
      let srcNode = null;
      let silencioCola = 0;

      try {
        actx = new (window.AudioContext || window.webkitAudioContext)();
        const ms = new MediaStream([mediaStreamTrack]);
        srcNode = actx.createMediaStreamSource(ms);
        proc = actx.createScriptProcessor(2048, 1, 1);
        const inRate = actx.sampleRate || 48000;
        const ratio = inRate / targetRate;

        proc.onaudioprocess = (ev) => {
          if (pub.isMuted || !this._room || !this._room._ws || this._room._ws.readyState !== WebSocket.OPEN) return;
          if (this._room._ws.bufferedAmount > 48 * 1024) return;
          const input = ev.inputBuffer.getChannelData(0);

          // Calcular energía RMS para Detector de Actividad de Voz (VAD)
          let sum = 0;
          for (let i = 0; i < input.length; i += 2) {
            sum += input[i] * input[i];
          }
          const rms = Math.sqrt(sum / (input.length / 2));
          if (rms > 0.012) {
            silencioCola = 6; // mantener cola de ~250ms al terminar de hablar
            this._room._marcarHablandoLocal(true);
          } else if (silencioCola > 0) {
            silencioCola--;
          } else {
            this._room._marcarHablandoLocal(false);
            return; // En silencio no gastamos ni un byte de red móvil
          }

          const outLen = Math.floor(input.length / ratio);
          // Trama: [FRAME_AUDIO (1B)][código sampleRate: 1=8kHz, 2=12kHz (1B)][muestras µ-law]
          const pkt = new Uint8Array(2 + outLen);
          pkt[0] = FRAME_AUDIO;
          pkt[1] = targetRate === 8000 ? 1 : 2;
          for (let i = 0; i < outLen; i++) {
            const idx = Math.min(input.length - 1, Math.floor(i * ratio));
            pkt[2 + i] = linearToUlaw(input[idx]);
          }
          try { this._room._ws.send(pkt); } catch {}
        };

        srcNode.connect(proc);
        proc.connect(actx.destination);
      } catch (e) {
        console.warn('Error iniciando codificador de voz Mumble:', e);
      }

      this._micCleanup = () => {
        try { if (proc) proc.disconnect(); } catch {}
        try { if (srcNode) srcNode.disconnect(); } catch {}
        try { if (actx) actx.close(); } catch {}
        this._room._marcarHablandoLocal(false);
      };
    }

    _iniciarEnvioAudioCompartido(mediaStreamTrack, pub, name) {
      let actx = null;
      let proc = null;
      let srcNode = null;
      try {
        this._room._ws.send(JSON.stringify({ t: 'audio_share_meta', activo: true, nombre: name }));
        actx = new (window.AudioContext || window.webkitAudioContext)();
        const ms = new MediaStream([mediaStreamTrack]);
        srcNode = actx.createMediaStreamSource(ms);
        proc = actx.createScriptProcessor(4096, 1, 1);
        const inRate = actx.sampleRate || 48000;
        const targetRate = 12000;
        const ratio = inRate / targetRate;

        proc.onaudioprocess = (ev) => {
          if (pub.isMuted || !this._room || !this._room._ws || this._room._ws.readyState !== WebSocket.OPEN) return;
          if (this._room._ws.bufferedAmount > 64 * 1024) return;
          const input = ev.inputBuffer.getChannelData(0);
          let sum = 0;
          for (let i = 0; i < input.length; i += 4) sum += input[i] * input[i];
          if (Math.sqrt(sum / (input.length / 4)) < 0.002) return;

          const outLen = Math.floor(input.length / ratio);
          const pkt = new Uint8Array(2 + outLen);
          pkt[0] = FRAME_AUDIO_SHARE;
          pkt[1] = 2; // 12kHz
          for (let i = 0; i < outLen; i++) {
            pkt[2 + i] = linearToUlaw(input[Math.min(input.length - 1, Math.floor(i * ratio))]);
          }
          try { this._room._ws.send(pkt); } catch {}
        };
        srcNode.connect(proc);
        proc.connect(actx.destination);
      } catch (e) {
        console.warn('Error compartiendo audio:', e);
      }
      this._ashCleanup = () => {
        try {
          if (this._room && this._room._ws && this._room._ws.readyState === WebSocket.OPEN) {
            this._room._ws.send(JSON.stringify({ t: 'audio_share_meta', activo: false }));
          }
        } catch {}
        try { if (proc) proc.disconnect(); } catch {}
        try { if (srcNode) srcNode.disconnect(); } catch {}
        try { if (actx) actx.close(); } catch {}
      };
    }

    async setCameraEnabled(enabled, constraints = {}) {
      if (!enabled) {
        if (this._camCleanup) {
          this._camCleanup();
          this._camCleanup = null;
        }
        const pub = this.pubs.get(TrackSource.Camera);
        if (pub) {
          this.pubs.delete(TrackSource.Camera);
          if (pub.track) pub.track.stop();
          this._room._enviarEstadoMedia();
          this._room.emit(RoomEvent.LocalTrackUnpublished, pub, this);
        }
        return;
      }

      if (!this._room._canCam) {
        throw new Error('La cámara solo está permitida en el Asiento 1 (Anfitrión) o con La Palabra');
      }

      const iniciarCaptura = async (cons) => {
        const videoCons = {
          width: { ideal: 320, max: 360 },
          height: { ideal: 240, max: 270 },
          frameRate: { ideal: 10, max: 12 },
          ...(cons || {}),
        };
        return await navigator.mediaDevices.getUserMedia({ video: videoCons, audio: false });
      };

      let stream;
      try {
        stream = await iniciarCaptura(constraints);
      } catch (e) {
        if (constraints && constraints.deviceId && e && e.name === 'OverconstrainedError') {
          stream = await iniciarCaptura({ deviceId: { ideal: constraints.deviceId.exact || constraints.deviceId } });
        } else {
          throw e;
        }
      }

      if (this._camCleanup) {
        this._camCleanup();
        this._camCleanup = null;
      }

      const vtrack = stream.getVideoTracks()[0];
      const track = new MediaTrack('video', TrackSource.Camera, vtrack);
      const pub = new TrackPublication(TrackSource.Camera, track, 'TR_CAM_' + this.identity, 'camera');

      // Soporte para cambiarCamara() en caliente con restartTrack()
      track._onRestart = async (newCons) => {
        const nuevoStream = await iniciarCaptura(newCons);
        const nuevoVt = nuevoStream.getVideoTracks()[0];
        if (track.mediaStreamTrack) {
          try { track.mediaStreamTrack.stop(); } catch {}
        }
        track.mediaStreamTrack = nuevoVt;
        for (const el of track._els) {
          el.srcObject = new MediaStream([nuevoVt]);
          el.play().catch(() => {});
        }
        if (videoHidden) {
          videoHidden.srcObject = new MediaStream([nuevoVt]);
          videoHidden.play().catch(() => {});
        }
      };

      this.pubs.set(TrackSource.Camera, pub);

      // Bucle de compresión 240p por WebSocket HTTPS/443 (10 fps, ~40-80 kbps)
      const videoHidden = document.createElement('video');
      videoHidden.muted = true;
      videoHidden.playsInline = true;
      videoHidden.autoplay = true;
      videoHidden.srcObject = stream;
      videoHidden.play().catch(() => {});

      const cv = document.createElement('canvas');
      cv.width = 320;
      cv.height = 240;
      const cx = cv.getContext('2d');
      let enviando = false;

      const timer = setInterval(() => {
        if (enviando || pub.isMuted || !this._room || !this._room._ws || this._room._ws.readyState !== WebSocket.OPEN) return;
        // Control de congestión para 3G/2G: si la cola del socket tiene >24 KB, saltar este frame
        if (this._room._ws.bufferedAmount > 24 * 1024) return;
        if (videoHidden.videoWidth <= 0) return;
        enviando = true;
        cx.drawImage(videoHidden, 0, 0, cv.width, cv.height);
        cv.toBlob((blob) => {
          if (!blob || !this._room || !this._room._ws || this._room._ws.readyState !== WebSocket.OPEN) {
            enviando = false;
            return;
          }
          blob.arrayBuffer().then((ab) => {
            const u8 = new Uint8Array(ab);
            const pkt = new Uint8Array(1 + u8.length);
            pkt[0] = FRAME_VIDEO;
            pkt.set(u8, 1);
            try { this._room._ws.send(pkt); } catch {}
            enviando = false;
          }).catch(() => { enviando = false; });
        }, 'image/webp', 0.48);
      }, 100); // 10 fps

      this._camCleanup = () => {
        clearInterval(timer);
        try { vtrack.stop(); } catch {}
        try { videoHidden.srcObject = null; } catch {}
      };

      this._room._enviarEstadoMedia();
      this._room.emit(RoomEvent.LocalTrackPublished, pub, this);
      return pub;
    }

    async setScreenShareEnabled(enabled) {
      if (!enabled) {
        if (this._scrCleanup) {
          this._scrCleanup();
          this._scrCleanup = null;
        }
        const pub = this.pubs.get(TrackSource.ScreenShare);
        if (pub) {
          this.pubs.delete(TrackSource.ScreenShare);
          if (pub.track) pub.track.stop();
          this._room._enviarEstadoMedia();
          this._room.emit(RoomEvent.LocalTrackUnpublished, pub, this);
        }
        return;
      }

      if (!this._room._canPan) {
        throw new Error('Compartir pantalla solo está permitido en el Asiento 1 o con La Palabra');
      }

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { max: 960 }, height: { max: 540 }, frameRate: { max: 5 } },
        audio: false,
      });
      const vtrack = stream.getVideoTracks()[0];
      vtrack.onended = () => { this.setScreenShareEnabled(false); };

      const track = new MediaTrack('video', TrackSource.ScreenShare, vtrack);
      const pub = new TrackPublication(TrackSource.ScreenShare, track, 'TR_SCR_' + this.identity, 'screen');
      this.pubs.set(TrackSource.ScreenShare, pub);

      const videoHidden = document.createElement('video');
      videoHidden.muted = true;
      videoHidden.playsInline = true;
      videoHidden.autoplay = true;
      videoHidden.srcObject = stream;
      videoHidden.play().catch(() => {});

      const cv = document.createElement('canvas');
      cv.width = 854;
      cv.height = 480;
      const cx = cv.getContext('2d');
      let enviando = false;

      const timer = setInterval(() => {
        if (enviando || pub.isMuted || !this._room || !this._room._ws || this._room._ws.readyState !== WebSocket.OPEN) return;
        if (this._room._ws.bufferedAmount > 32 * 1024) return;
        if (videoHidden.videoWidth <= 0) return;
        enviando = true;
        cx.drawImage(videoHidden, 0, 0, cv.width, cv.height);
        cv.toBlob((blob) => {
          if (!blob || !this._room || !this._room._ws || this._room._ws.readyState !== WebSocket.OPEN) {
            enviando = false;
            return;
          }
          blob.arrayBuffer().then((ab) => {
            const u8 = new Uint8Array(ab);
            const pkt = new Uint8Array(1 + u8.length);
            pkt[0] = FRAME_SCREEN;
            pkt.set(u8, 1);
            try { this._room._ws.send(pkt); } catch {}
            enviando = false;
          }).catch(() => { enviando = false; });
        }, 'image/webp', 0.55);
      }, 250); // 4 fps para pantalla legible y ligera

      this._scrCleanup = () => {
        clearInterval(timer);
        try { vtrack.stop(); } catch {}
        try { videoHidden.srcObject = null; } catch {}
      };

      this._room._enviarEstadoMedia();
      this._room.emit(RoomEvent.LocalTrackPublished, pub, this);
      return pub;
    }
  }

  class Room extends Emitter {
    constructor() {
      super();
      this.localParticipant = new LocalParticipant(this);
      this.remoteParticipants = new Map();
      this.disconnectReason = undefined;
      this._ws = null;
      this._canMic = false;
      this._canCam = false;
      this._canPan = false;
      this._rxAudioCtx = null;
      this._rxPipelines = new Map(); // key -> { ctx, dest, nextTime, pub, participant }
      this._speakers = new Map();    // identity -> expireTs
      this._speakerTimer = null;
    }

    _asegurarRxAudioCtx() {
      if (!this._rxAudioCtx || this._rxAudioCtx.state === 'closed') {
        this._rxAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (this._rxAudioCtx.state === 'suspended') {
        this._rxAudioCtx.resume().catch(() => {});
      }
      return this._rxAudioCtx;
    }

    _marcarHablandoLocal(hablando) {
      const id = this.localParticipant.identity;
      if (!id) return;
      if (hablando) {
        this._speakers.set(id, Date.now() + 600);
      } else {
        this._speakers.delete(id);
      }
      if (this._localHablando !== hablando) {
        this._localHablando = hablando;
        this._actualizarSpeakers();
      }
    }

    _actualizarSpeakers() {
      const now = Date.now();
      const activos = [];
      for (const [id, exp] of this._speakers.entries()) {
        if (exp > now) {
          const p = id === this.localParticipant.identity
            ? this.localParticipant
            : this.remoteParticipants.get(id);
          if (p) activos.push(p);
        } else {
          this._speakers.delete(id);
        }
      }
      const clave = activos.map(p => p.identity).join(',');
      if (clave === this._ultSpeakersClave) return;
      this._ultSpeakersClave = clave;
      this.emit(RoomEvent.ActiveSpeakersChanged, activos);
    }

    _enviarEstadoMedia() {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
      try {
        this._ws.send(JSON.stringify({
          t: 'estado_media',
          mic: this.localParticipant.isMicrophoneEnabled,
          cam: this.localParticipant.isCameraEnabled,
          pan: this.localParticipant.isScreenShareEnabled,
        }));
      } catch {}
    }

    async connect(baseUrl, token) {
      // Decodificar identidad y nombre del token (base64url antes del punto)
      try {
        const b64 = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
        const claims = JSON.parse(atob(b64));
        this.localParticipant.identity = claims.sub || '';
        this.localParticipant.name = claims.name || claims.sub || '';
        this._canMic = !!claims.mic;
        this._canCam = !!claims.cam;
        this._canPan = !!claims.pan;
      } catch {}

      const sala = (window.S && window.S.sala) || new URLSearchParams(location.search).get('sala') || '';
      const wsBase = (baseUrl || location.origin).replace(/^http/, 'ws').replace(/\/$/, '');
      const wsUrl = `${wsBase}/api/salas/${encodeURIComponent(sala)}/media?token=${encodeURIComponent(token)}`;

      await new Promise((resolve, reject) => {
        let conectado = false;
        const ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';
        this._ws = ws;

        const timeout = setTimeout(() => {
          if (!conectado) {
            try { ws.close(); } catch {}
            reject(new Error('Tiempo agotado conectando al canal de voz Mumble'));
          }
        }, 12000);

        ws.onopen = () => {
          conectado = true;
          clearTimeout(timeout);
          this._speakerTimer = setInterval(() => this._actualizarSpeakers(), 300);
          this.emit(RoomEvent.ConnectionStateChanged, 'connected');
          resolve();
        };

        ws.onerror = () => {
          if (!conectado) {
            clearTimeout(timeout);
            reject(new Error('No se pudo abrir la conexión WebSocket HTTPS'));
          }
        };

        ws.onmessage = (ev) => {
          if (typeof ev.data === 'string') {
            this._manejarTexto(ev.data);
          } else if (ev.data instanceof ArrayBuffer) {
            this._manejarBinario(new Uint8Array(ev.data));
          }
        };

        ws.onclose = (ev) => {
          clearTimeout(timeout);
          if (this._speakerTimer) {
            clearInterval(this._speakerTimer);
            this._speakerTimer = null;
          }
          if (!conectado) {
            reject(new Error('Conexión cerrada antes de iniciar'));
            return;
          }
          if (ev.code === 4002 || ev.reason === 'DUPLICATE_IDENTITY') {
            this.disconnectReason = DisconnectReason.DUPLICATE_IDENTITY;
          }
          this.emit(RoomEvent.Disconnected, this.disconnectReason);
        };
      });
    }

    async disconnect() {
      if (this.localParticipant._micCleanup) this.localParticipant._micCleanup();
      if (this.localParticipant._camCleanup) this.localParticipant._camCleanup();
      if (this.localParticipant._scrCleanup) this.localParticipant._scrCleanup();
      if (this.localParticipant._ashCleanup) this.localParticipant._ashCleanup();
      if (this._speakerTimer) {
        clearInterval(this._speakerTimer);
        this._speakerTimer = null;
      }
      if (this._ws) {
        const ws = this._ws;
        this._ws = null;
        try { ws.close(1000, 'client disconnect'); } catch {}
      }
      if (this._rxAudioCtx) {
        try { this._rxAudioCtx.close(); } catch {}
        this._rxAudioCtx = null;
      }
    }

    _manejarTexto(raw) {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      switch (m.t) {
        case 'bienvenida':
          this.localParticipant.identity = m.identidad || this.localParticipant.identity;
          this._canMic = !!m.canMic;
          this._canCam = !!m.canCam;
          this._canPan = !!m.canPan;
          break;

        case 'permisos':
          this._canMic = !!m.canMic;
          this._canCam = !!m.canCam;
          this._canPan = !!m.canPan;
          if (!this._canMic) {
            const mp = this.localParticipant.getTrackPublication(TrackSource.Microphone);
            if (mp) {
              if (mp.track) mp.track.stop();
              this.localParticipant.unpublishTrack(mp.track).catch(() => {});
            }
          }
          if (!this._canCam && this.localParticipant.isCameraEnabled) {
            this.localParticipant.setCameraEnabled(false).catch(() => {});
          }
          if (!this._canPan && this.localParticipant.isScreenShareEnabled) {
            this.localParticipant.setScreenShareEnabled(false).catch(() => {});
          }
          this.emit(RoomEvent.ParticipantPermissionsChanged, null, this.localParticipant);
          break;

        case 'forzar_mute':
          if (m.mic) {
            const mp = this.localParticipant.getTrackPublication(TrackSource.Microphone);
            if (mp) {
              if (mp.track) mp.track.stop();
              this.localParticipant.unpublishTrack(mp.track).catch(() => {});
            }
          }
          if (m.cam && this.localParticipant.isCameraEnabled) {
            this.localParticipant.setCameraEnabled(false).catch(() => {});
          }
          break;

        case 'peers':
          this._sincronizarPeers(m.peers || []);
          break;

        case 'estado_push':
          if (m.d && typeof window.aplicarEstado === 'function') {
            try { window.aplicarEstado(m.d, 'sse'); } catch {}
          }
          break;

        case 'audio_share_meta': {
          const from = m.from;
          if (!from || from === this.localParticipant.identity) break;
          const p = this.remoteParticipants.get(from);
          if (!p) break;
          if (!m.activo) {
            const pub = p.pubs.get(TrackSource.ScreenShareAudio);
            if (pub) {
              p.pubs.delete(TrackSource.ScreenShareAudio);
              this.emit(RoomEvent.TrackUnsubscribed, pub.track, pub, p);
            }
          } else {
            this._asegurarAudioRemoto(p, TrackSource.ScreenShareAudio, m.nombre || '🎵 Audio');
          }
          break;
        }

        default: {
          // Mensajes de datos de la aplicación (chat, wb, reaccion, aud_vol...)
          const fromId = m.from || '';
          const p = this.remoteParticipants.get(fromId) || {
            identity: fromId,
            name: m.fromName || fromId,
          };
          const bytes = new TextEncoder().encode(raw);
          this.emit(RoomEvent.DataReceived, bytes, p);
          break;
        }
      }
    }

    _sincronizarPeers(lista) {
      const vistos = new Set();
      for (const info of lista) {
        if (!info.identidad) continue;
        if (info.identidad === this.localParticipant.identity) {
          this.localParticipant.name = info.nombre || this.localParticipant.name;
          this._canMic = !!info.canMic;
          this._canCam = !!info.canCam;
          this._canPan = !!info.canPan;
          continue;
        }
        vistos.add(info.identidad);
        let p = this.remoteParticipants.get(info.identidad);
        const esNuevo = !p;
        if (!p) {
          p = new Participant(info.identidad, info.nombre, false, this);
          this.remoteParticipants.set(info.identidad, p);
        } else {
          p.name = info.nombre || p.name;
        }

        // Sincronizar estado de micrófono remoto
        if (info.mic) {
          const pub = this._asegurarAudioRemoto(p, TrackSource.Microphone, 'microfono');
          if (pub.isMuted) {
            pub.isMuted = false;
            this.emit(RoomEvent.TrackUnmuted, pub, p);
          }
        } else {
          const pub = p.pubs.get(TrackSource.Microphone);
          if (pub && !pub.isMuted) {
            pub.isMuted = true;
            this.emit(RoomEvent.TrackMuted, pub, p);
          }
        }

        // Sincronizar estado de cámara remota
        if (!info.cam) {
          const pub = p.pubs.get(TrackSource.Camera);
          if (pub) {
            p.pubs.delete(TrackSource.Camera);
            this.emit(RoomEvent.TrackUnsubscribed, pub.track, pub, p);
          }
        }

        // Sincronizar estado de pantalla remota
        if (!info.pan) {
          const pub = p.pubs.get(TrackSource.ScreenShare);
          if (pub) {
            p.pubs.delete(TrackSource.ScreenShare);
            this.emit(RoomEvent.TrackUnsubscribed, pub.track, pub, p);
          }
        }

        if (esNuevo) {
          this.emit(RoomEvent.ParticipantConnected, p);
        }
      }

      // Quitar participantes que salieron del grupo/sala
      for (const [id, p] of [...this.remoteParticipants.entries()]) {
        if (!vistos.has(id)) {
          for (const pub of p.pubs.values()) {
            this.emit(RoomEvent.TrackUnsubscribed, pub.track, pub, p);
          }
          p.pubs.clear();
          this.remoteParticipants.delete(id);
          this.emit(RoomEvent.ParticipantDisconnected, p);
        }
      }
      this.emit(RoomEvent.ConnectionStateChanged, 'connected');
    }

    _asegurarAudioRemoto(p, source, nombre) {
      let pub = p.pubs.get(source);
      if (pub) return pub;

      const ctx = this._asegurarRxAudioCtx();
      const dest = ctx.createMediaStreamDestination();
      const msTrack = dest.stream.getAudioTracks()[0];
      const track = new MediaTrack('audio', source, msTrack);
      const sid = 'TR_' + source + '_' + p.identity;
      pub = new TrackPublication(source, track, sid, nombre);
      p.pubs.set(source, pub);
      this._rxPipelines.set(sid, { ctx, dest, nextTime: 0, pub, p });
      this.emit(RoomEvent.TrackSubscribed, track, pub, p);
      return pub;
    }

    _asegurarVideoRemoto(p, source, width, height) {
      let pub = p.pubs.get(source);
      if (pub) return pub;

      const cv = document.createElement('canvas');
      cv.width = width;
      cv.height = height;
      const cx = cv.getContext('2d');
      const track = new MediaTrack('video', source, null);
      track._canvas = cv;
      track._ctx2d = cx;
      const sid = 'TR_' + source + '_' + p.identity;
      pub = new TrackPublication(source, track, sid, source);
      p.pubs.set(source, pub);
      this.emit(RoomEvent.TrackSubscribed, track, pub, p);
      return pub;
    }

    _manejarBinario(u8) {
      if (u8.length < 4) return;
      const ftipo = u8[0];
      const idLen = u8[1];
      if (2 + idLen > u8.length) return;
      const fromId = new TextDecoder().decode(u8.subarray(2, 2 + idLen));
      if (!fromId || fromId === this.localParticipant.identity) return;
      const payload = u8.subarray(2 + idLen);

      let p = this.remoteParticipants.get(fromId);
      if (!p) {
        p = new Participant(fromId, fromId, false, this);
        this.remoteParticipants.set(fromId, p);
        this.emit(RoomEvent.ParticipantConnected, p);
      }

      if (ftipo === FRAME_AUDIO || ftipo === FRAME_AUDIO_SHARE) {
        if (payload.length < 2) return;
        const rateCode = payload[0];
        const sampleRate = rateCode === 1 ? 8000 : 12000;
        const samples = payload.subarray(1);

        const source = ftipo === FRAME_AUDIO_SHARE ? TrackSource.ScreenShareAudio : TrackSource.Microphone;
        const pub = this._asegurarAudioRemoto(p, source, ftipo === FRAME_AUDIO_SHARE ? '🎵 Audio' : 'microfono');
        if (pub.isMuted) {
          pub.isMuted = false;
          this.emit(RoomEvent.TrackUnmuted, pub, p);
        }

        const pipe = this._rxPipelines.get(pub.trackSid);
        if (!pipe) return;
        const ctx = this._asegurarRxAudioCtx();
        const audioBuf = ctx.createBuffer(1, samples.length, sampleRate);
        const ch = audioBuf.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < samples.length; i++) {
          const v = ulawDecodeTable[samples[i]];
          ch[i] = v;
          sum += v * v;
        }
        const src = ctx.createBufferSource();
        src.buffer = audioBuf;
        src.connect(pipe.dest);

        // Jitter buffer adaptativo ligero (60ms de colchón para redes móviles)
        const now = ctx.currentTime;
        if (pipe.nextTime < now || pipe.nextTime > now + 0.45) {
          pipe.nextTime = now + 0.06;
        }
        src.start(pipe.nextTime);
        pipe.nextTime += audioBuf.duration;

        if (ftipo === FRAME_AUDIO && Math.sqrt(sum / samples.length) > 0.015) {
          this._speakers.set(fromId, Date.now() + 650);
          this._actualizarSpeakers();
        }
        return;
      }

      if (ftipo === FRAME_VIDEO || ftipo === FRAME_SCREEN) {
        const isScreen = ftipo === FRAME_SCREEN;
        const source = isScreen ? TrackSource.ScreenShare : TrackSource.Camera;
        const pub = this._asegurarVideoRemoto(p, source, isScreen ? 854 : 320, isScreen ? 480 : 240);
        const blob = new Blob([payload], { type: 'image/webp' });
        if (window.createImageBitmap) {
          createImageBitmap(blob).then((bmp) => {
            const cv = pub.track._canvas;
            const cx = pub.track._ctx2d;
            if (cv && cx) {
              cx.drawImage(bmp, 0, 0, cv.width, cv.height);
            }
            bmp.close();
          }).catch(() => {});
        } else {
          const url = URL.createObjectURL(blob);
          const img = new Image();
          img.onload = () => {
            const cv = pub.track._canvas;
            const cx = pub.track._ctx2d;
            if (cv && cx) cx.drawImage(img, 0, 0, cv.width, cv.height);
            URL.revokeObjectURL(url);
          };
          img.onerror = () => URL.revokeObjectURL(url);
          img.src = url;
        }
      }
    }
  }

  window.LivekitClient = {
    Room,
    RoomEvent,
    Track: { Source: TrackSource },
    ConnectionQuality,
    DisconnectReason,
    VideoPresets,
    AudioPresets,
  };
})();
