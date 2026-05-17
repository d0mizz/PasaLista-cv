/**
 * Módulo QR — generación, almacenamiento en Firebase Storage
 * y parseo de lecturas del escáner.
 */
const qrModule = {

  PREFIX: 'PASALISTA:',
  SIZE: 280,
  _scanLock: false,

  /** Texto que va dentro del código QR (escaneable por el lector). */
  encodePayload(codigo) {
    return `${this.PREFIX}${String(codigo).trim()}`;
  },

  /** Extrae el código de alumno desde lo leído por la cámara. */
  parseScannedText(raw) {
    if (!raw) return '';
    let text = String(raw).trim();

    // BOM, espacios raros o saltos de línea del lector
    text = text.replace(/^\uFEFF/, '').replace(/\s+/g, '');

    const prefixUpper = this.PREFIX.toUpperCase();
    if (text.toUpperCase().startsWith(prefixUpper)) {
      return text.slice(this.PREFIX.length).trim();
    }

    try {
      const json = JSON.parse(text);
      if (json.codigo) return String(json.codigo).trim();
      if (json.code) return String(json.code).trim();
    } catch (_) {}

    const match = text.match(/(\d{6,})/);
    if (match) return match[1];

    return text.replace(/\D/g, '') || text;
  },

  /** Genera un Blob PNG del QR para un código de alumno. */
  async createQRBlob(codigo) {
    const payload = this.encodePayload(codigo);

    return new Promise((resolve, reject) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
      document.body.appendChild(wrap);

      try {
        new QRCode(wrap, {
          text: payload,
          width: this.SIZE,
          height: this.SIZE,
          colorDark: '#1a1a2e',
          colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.M
        });
      } catch (e) {
        document.body.removeChild(wrap);
        reject(e);
        return;
      }

      const finish = () => {
        const canvas = wrap.querySelector('canvas');
        const img = wrap.querySelector('img');

        const done = (blob) => {
          document.body.removeChild(wrap);
          if (blob) resolve(blob);
          else reject(new Error('No se pudo generar la imagen QR'));
        };

        if (canvas) {
          canvas.toBlob(done, 'image/png', 0.92);
          return;
        }

        if (img) {
          const c = document.createElement('canvas');
          c.width = this.SIZE;
          c.height = this.SIZE;
          const ctx = c.getContext('2d');
          img.onload = () => {
            ctx.drawImage(img, 0, 0, this.SIZE, this.SIZE);
            c.toBlob(done, 'image/png', 0.92);
          };
          img.onerror = () => done(null);
          if (img.complete) img.onload();
          return;
        }

        done(null);
      };

      setTimeout(finish, 80);
    });
  },

  storagePath(codigo) {
    return `qr-codes/${codigo}.png`;
  },

  getStorage() {
    if (STATE.demoMode || !appCore.storage) return null;
    return appCore.storage;
  },

  /** Sube PNG a Storage y guarda la URL en Realtime Database. */
  async generateForAlumno(alumno) {
    if (!alumno?.codigo) {
      throw new Error('Alumno sin código');
    }

    const codigo = String(alumno.codigo).trim();
    const blob = await this.createQRBlob(codigo);
    const path = this.storagePath(codigo);
    const storage = this.getStorage();

    let downloadUrl = null;

    if (storage) {
      const ref = storage.ref().child(path);
      await ref.put(blob, {
        contentType: 'image/png',
        customMetadata: {
          codigo,
          alumnoId: alumno.id || '',
          generadoEn: new Date().toISOString()
        }
      });
      downloadUrl = await ref.getDownloadURL();
    } else {
      downloadUrl = URL.createObjectURL(blob);
    }

    const qrData = {
      url: downloadUrl,
      path,
      codigo,
      generadoEn: new Date().toISOString()
    };

    const id = alumno.id || `a_${codigo}`;
    if (STATE.alumnos[id]) {
      STATE.alumnos[id].qr = qrData;
    }

    if (!STATE.demoMode && appCore.db) {
      await appCore.db.ref(`alumnos/${id}/qr`).set(qrData);
    }

    return qrData;
  },

  async generateAll(onProgress) {
    const list = Object.values(STATE.alumnos).filter(a => a.activo !== false && a.codigo);
    let ok = 0;
    let fail = 0;

    for (let i = 0; i < list.length; i++) {
      const alumno = list[i];
      try {
        await this.generateForAlumno(alumno);
        ok++;
      } catch (e) {
        console.error('QR error', alumno.codigo, e);
        fail++;
      }
      if (onProgress) onProgress(i + 1, list.length, alumno, ok, fail);
    }

    return { ok, fail, total: list.length };
  },

  hasQR(alumno) {
    return !!(alumno?.qr?.url);
  },

  resetScanLock() {
    this._scanLock = false;
    if (this._scanLockTimer) clearTimeout(this._scanLockTimer);
  },

  /** Evita lecturas duplicadas seguidas del mismo código. */
  canProcessScan() {
    if (this._scanLock) return false;
    this._scanLock = true;
    this._scanLockTimer = setTimeout(() => { this._scanLock = false; }, 2500);
    return true;
  },

  handleScan(rawText) {
    const codigo = this.parseScannedText(rawText);
    if (!codigo) {
      return { codigo: null, msg: 'Código QR no válido' };
    }
    if (!this.canProcessScan()) {
      return { codigo: null, msg: 'Espera un momento...' };
    }
    return { codigo, raw: rawText };
  }
};
