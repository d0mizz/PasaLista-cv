const firebaseConfig = {
  apiKey: "AIzaSyAcqGT_3Vu0YDsLjWEf3wFilhi25Re37yw",
  authDomain: "pasalista-7a70d.firebaseapp.com",
  databaseURL: "https://pasalista-7a70d-default-rtdb.firebaseio.com",
  projectId: "pasalista-7a70d",
  storageBucket: "pasalista-7a70d.firebasestorage.app",
  appId: "1:578094708275:web:61d16992900de582d35546"
};

const STATE = {
  user: null,
  userProfile: null,   // { role: 'admin'|'operator', permisos: {...}, ... }
  alumnos: {},
  asistencias: {},
  inasistencias: {},
  tardanzas: {},
  config: { horaLimite: '07:30', minAsistencia: 70 },
  demoMode: false,
  scanner: null,
  _processingQR: false
};


const appCore = {

  init() {
    try {
      firebase.initializeApp(firebaseConfig);
      this.db      = firebase.database();
      this.auth    = firebase.auth();
      this.storage = firebase.storage();
      this.setupListeners();

      setTimeout(() => {
        document.getElementById('app-loader').classList.add('hide');
        if (!STATE.user) ui.showLogin();
      }, 1500);

    } catch (e) {
      console.error("Firebase error:", e);
      document.getElementById('app-loader').classList.add('hide');
      ui.showLogin();
    }
  },

  setupListeners() {
    this.auth.onAuthStateChanged(async user => {
      try {
        if (user) {

          STATE.user = {
            uid: user.uid,
            email: user.email,
            displayName: user.displayName || user.email.split('@')[0]
          };

          // ── Cargar perfil desde /usuarios/{uid} ──────────────────────────
          const profileSnap = await this.db.ref(`usuarios/${user.uid}`).once('value');
          let profile = profileSnap.val();

          if (!profile) {
            // Primera vez que este usuario inicia sesión:
            // lo registramos como admin (ya que no existe ningún perfil previo
            // y es el dueño de la cuenta Firebase)
            profile = {
              uid: user.uid,
              displayName: user.displayName || user.email.split('@')[0],
              email: user.email,
              role: 'admin',
              permisos: {
                dashboard: true,
                scanner: true,
                reportes: true,
                configuracion: true,
                alumnos: true,
                importar: true,
                editarConfiguracion: true
              },
              creadoEn: new Date().toISOString()
            };
            await this.db.ref(`usuarios/${user.uid}`).set(profile);
          }

          STATE.userProfile = profile;

          // Actualizar displayName en STATE si el perfil lo tiene
          if (profile.displayName) {
            STATE.user.displayName = profile.displayName;
          }

          await this.loadAllData();
          ui.initApp();

        } else {
          STATE.userProfile = null;
          ui.showLogin();
        }
      } catch (e) {
        console.error(e);
        ui.showLogin();
      }
    });
  },

  async loadAllData() {
    try {
      const snap = await this.db.ref('/').once('value');
      const data = snap.val() || {};

      STATE.alumnos       = data.alumnos       || {};
      STATE.tardanzas     = data.tardanzas     || {};
      STATE.asistencias   = data.asistencias   || {};
      STATE.inasistencias = data.inasistencias || {};
      STATE.config = data.config || { horaLimite: '07:30', minAsistencia: 70 };

    } catch (e) {
      console.error("Error loading Firebase:", e);
      STATE.alumnos   = {};
      STATE.tardanzas = {};
    }
  },

  // ── tipoForzado: 'tardanza' | 'inasistencia' | null (auto) ──────────────
  findAlumnoByCodigo(code) {
    const c = String(code || '').trim();
    return Object.values(STATE.alumnos).find(a => String(a.codigo || '').trim() === c);
  },

  async processScan(code, justificacion = '', tipoForzado = null) {

    const alumno = this.findAlumnoByCodigo(code);

    if (!alumno) {
      return { success: false, msg: "Alumno no encontrado" };
    }

    const now        = new Date();
    const horaActual = now.toTimeString().slice(0, 5);
    const fecha      = now.toISOString().split('T')[0];
    const entryId    = `${fecha}_${alumno.id}`;

    // ── Si es INASISTENCIA forzada ───────────────────────────────────────
    if (tipoForzado === 'inasistencia') {

      if (STATE.inasistencias[entryId]) {
        return { success: false, msg: "La inasistencia ya fue registrada" };
      }

      const data = {
        alumnoId:      alumno.id,
        codigo:        alumno.codigo,
        nombre:        `${alumno.apellidos}, ${alumno.nombres}`,
        fecha,
        hora:          horaActual,
        tipo:          'inasistencia',
        estado:        'inasistencia',
        justificacion: justificacion || ''
      };

      STATE.inasistencias[entryId] = data;

      try {
        await this.db.ref(`inasistencias/${entryId}`).set(data);
      } catch (e) {
        console.error(e);
      }

      return { success: true, alumno, data };
    }

    // ── TARDANZA (forzada o automática) ──────────────────────────────────
    const esTardanza = tipoForzado === 'tardanza' || horaActual > STATE.config.horaLimite;

    if (!esTardanza) {
      return { success: false, msg: "No se registra tardanza antes de la hora límite" };
    }

    if (STATE.tardanzas[entryId]) {
      return { success: false, msg: "La tardanza ya fue registrada" };
    }

    const data = {
      alumnoId:      alumno.id,
      codigo:        alumno.codigo,
      nombre:        `${alumno.apellidos}, ${alumno.nombres}`,
      fecha,
      hora:          horaActual,
      tipo:          'tardanza',
      estado:        'tardanza',
      justificacion: justificacion || ''
    };

    STATE.tardanzas[entryId] = data;

    try {
      await this.db.ref(`tardanzas/${entryId}`).set(data);
    } catch (e) {
      console.error(e);
    }

    return { success: true, alumno, data };
  },

  async pauseScanner() {
    if (STATE.scanner) {
      try { await STATE.scanner.pause(true); } catch (e) {}
    }
  },

  async startScanner() {
    const reader = document.getElementById('qr-reader');
    if (STATE.scanner) {
      try { await STATE.scanner.stop(); } catch (e) {}
      STATE.scanner = null;
    }
    reader.innerHTML = '';
    qrModule.resetScanLock();

    try {
      STATE.scanner = new Html5Qrcode("qr-reader");
      const config = {
        fps: 10,
        qrbox: (viewfinderWidth, viewfinderHeight) => {
          const minEdge = Math.min(viewfinderWidth, viewfinderHeight);
          const size = Math.max(200, Math.floor(minEdge * 0.75));
          return { width: size, height: size };
        },
        disableFlip: false
      };

      const onScanSuccess = (decodedText) => {
        appCore.onQRDecoded(decodedText);
      };

      await STATE.scanner.start(
        { facingMode: "environment" },
        config,
        onScanSuccess,
        () => {}
      );
      document.getElementById('btn-start-scan').classList.add('hide');
      document.getElementById('btn-stop-scan').classList.remove('hide');
      document.getElementById('scanner-status').textContent = 'Activo';
      document.getElementById('scanner-status').className = 'badge badge-success';
    } catch (e) {
      ui.showToast('No se pudo iniciar la cámara: ' + e.message, 'error');
      reader.innerHTML = '<div style="padding:30px;text-align:center;color:var(--text-mute)">Cámara no disponible. Use el modo manual.</div>';
    }
  },

  /** Procesa un QR leído — no bloquear con await stop() aquí (cuelga el callback). */
  async onQRDecoded(decodedText) {
    if (STATE._processingQR) return;
    STATE._processingQR = true;

    try {
      const parsed = qrModule.handleScan(decodedText);
      if (!parsed.codigo) {
        ui.showToast(parsed.msg || 'QR no reconocido', 'error');
        qrModule.resetScanLock();
        return;
      }

      const alumno = this.findAlumnoByCodigo(parsed.codigo);
      if (!alumno) {
        ui.showToast(`Alumno no encontrado (${parsed.codigo})`, 'error');
        qrModule.resetScanLock();
        return;
      }

      ui.showToast(`QR detectado: ${alumno.nombres}`, 'info');

      // Pausar cámara sin bloquear; abrir modal de inmediato
      this.pauseScanner();
      ui.openJustificacionModal(parsed.codigo, alumno);

      // Detener cámara en segundo plano (evita colgar el callback)
      setTimeout(() => this.stopScanner(), 300);
    } catch (e) {
      console.error('Error al procesar QR:', e);
      ui.showToast('Error al leer el QR', 'error');
      qrModule.resetScanLock();
    } finally {
      setTimeout(() => { STATE._processingQR = false; }, 1500);
    }
  },

  async stopScanner() {
    if (STATE.scanner) {
      try { await STATE.scanner.stop(); } catch (e) {}
      try { STATE.scanner.clear(); } catch (e) {}
      STATE.scanner = null;
    }
    const reader = document.getElementById('qr-reader');
    if (reader) reader.innerHTML = '';
    document.getElementById('btn-start-scan')?.classList.remove('hide');
    document.getElementById('btn-stop-scan')?.classList.add('hide');
    document.getElementById('scanner-status').textContent = 'Inactivo';
    document.getElementById('scanner-status').className = 'badge';
  },

  async handleFile(ev) {
    const file = ev.target.files[0];
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'pdf') await this.parsePDF(file);
    else if (['xlsx', 'xls'].includes(ext)) await this.parseExcel(file);
    else ui.showToast('Formato no soportado', 'error');
  },

  async parsePDF(file) {
    try {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      const alumnos = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const tc   = await page.getTextContent();
        const lines = tc.items.map(it => it.str).join(' ').split(new RegExp('\\n+'));
        lines.forEach(line => {
          const m = line.match(new RegExp('(\\d{8,})\\s+([A-ZÁÉÍÓÚÑa-záéíóúñ\\s]+),?\\s+([A-ZÁÉÍÓÚÑa-záéíóúñ\\s]+)'));
          if (m) alumnos.push({ codigo: m[1], apellidos: m[2].trim(), nombres: m[3].trim() });
        });
      }
      this.importAlumnos(alumnos);
    } catch (e) {
      ui.showToast('Error al leer PDF: ' + e.message, 'error');
    }
  },

  async parseExcel(file) {
    try {
      const buf  = await file.arrayBuffer();
      const wb   = XLSX.read(buf, { type: 'array' });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
      const alumnos = rows.map(r => ({
        codigo:   String(r.codigo   || r.Codigo   || r.CODIGO   || ''),
        apellidos: r.apellidos || r.Apellidos || r.APELLIDOS || '',
        nombres:   r.nombres   || r.Nombres   || r.NOMBRES   || '',
        grado:     r.grado     || r.Grado     || '',
        seccion:   r.seccion   || r.Seccion   || ''
      })).filter(a => a.codigo);
      this.importAlumnos(alumnos);
    } catch (e) {
      ui.showToast('Error Excel: ' + e.message, 'error');
    }
  },

  async importAlumnos(arr) {
    let count = 0;
    for (const a of arr) {
      const id = 'a_' + a.codigo;
      STATE.alumnos[id] = { id, ...a, activo: true };
      if (!STATE.demoMode && this.db) {
        try { await this.db.ref(`alumnos/${id}`).set(STATE.alumnos[id]); } catch (e) {}
      }
      count++;
    }
    ui.showToast(`${count} alumnos importados`, 'success');
    ui.renderAlumnos();
    ui.updateDashboard();
    const prev = document.getElementById('import-preview');
    if (prev) prev.innerHTML = `<p class="muted" style="margin-top:14px">✓ ${count} registros procesados. Generando códigos QR...</p>`;

    try {
      const res = await qrModule.generateAll();
      ui.showToast(`QR generados: ${res.ok} de ${res.total}`, res.fail ? 'info' : 'success');
      ui.renderAlumnos();
    } catch (e) {
      console.error(e);
      ui.showToast('Alumnos importados; error al generar QR', 'error');
    }
  },

  exportAlumnos() {
    const data = Object.values(STATE.alumnos).map(a => ({
      Codigo: a.codigo, Apellidos: a.apellidos, Nombres: a.nombres,
      Grado: a.grado, Seccion: a.seccion, Activo: a.activo ? 'Sí' : 'No'
    }));
    this.exportExcel(data, 'alumnos_' + new Date().toISOString().split('T')[0]);
  },

  exportReporteExcel() {
    const data = getFilteredRecords().map(r => ({
      Fecha:         r.fecha,
      Alumno:        r.nombre,
      Grado:         STATE.alumnos[r.alumnoId]?.grado   || '-',
      Seccion:       STATE.alumnos[r.alumnoId]?.seccion || '-',
      Hora:          r.hora          || '-',
      Estado:        r.estado,
      Justificacion: r.justificacion || '-'
    }));
    this.exportExcel(data, 'reporte_' + new Date().toISOString().split('T')[0]);
  },

  exportExcel(data, filename) {
    if (!data.length) { ui.showToast('No hay datos', 'error'); return; }
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Datos");
    XLSX.writeFile(wb, `${filename}.xlsx`);
    ui.showToast('Excel exportado', 'success');
  },

  exportReportePDF() {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    doc.setFontSize(18);
    doc.text('Reporte de Asistencias', 14, 18);
    doc.setFontSize(10);
    doc.text(new Date().toLocaleDateString(), 14, 26);
    const body = getFilteredRecords().map(r => [
      r.fecha,
      r.nombre,
      STATE.alumnos[r.alumnoId]?.grado   || '-',
      STATE.alumnos[r.alumnoId]?.seccion || '-',
      r.hora   || '-',
      r.estado,
      r.justificacion || '-'
    ]);
    doc.autoTable({
      head: [['Fecha','Alumno','Grado','Sección','Hora','Estado','Justificación']],
      body,
      startY: 32,
      theme: 'striped',
      headStyles: { fillColor: [192, 57, 43] }
    });
    doc.save('reporte_asistencia.pdf');
    ui.showToast('PDF exportado', 'success');
  },

  saveConfig() {
    // Verificar permiso
    if (!ui.isAdmin()) {
      ui.showToast('No tienes permiso para modificar la configuración', 'error');
      return;
    }
    STATE.config.horaLimite    = document.getElementById('cfg-hora').value;
    STATE.config.minAsistencia = parseInt(document.getElementById('cfg-min').value);
    if (!STATE.demoMode && this.db) {
      try { this.db.ref('config').set(STATE.config); } catch (e) {}
    }
    ui.showToast('Configuración guardada', 'success');
  },

  async addAlumno(data) {
    const id = 'a_' + data.codigo;
    STATE.alumnos[id] = { id, ...data, activo: true };
    if (!STATE.demoMode && this.db) {
      try { await this.db.ref(`alumnos/${id}`).set(STATE.alumnos[id]); } catch (e) {}
    }
    ui.showToast('Alumno agregado', 'success');
    ui.renderAlumnos();
    ui.updateDashboard();

    try {
      await qrModule.generateForAlumno(STATE.alumnos[id]);
      ui.showToast('Código QR generado', 'success');
      ui.renderAlumnos();
    } catch (e) {
      console.error(e);
      ui.showToast('Alumno guardado; no se pudo generar el QR', 'error');
    }
  },

  deleteAlumno(id) {
    delete STATE.alumnos[id];
    if (!STATE.demoMode && this.db) {
      try { this.db.ref(`alumnos/${id}`).remove(); } catch (e) {}
    }
    ui.renderAlumnos();
    ui.updateDashboard();
    ui.showToast('Alumno eliminado', 'info');
  }
};


const authModule = {

  async login() {
    const email = document.getElementById('login-email').value;
    const pass  = document.getElementById('login-pass').value;
    const errEl = document.getElementById('login-error');
    errEl.classList.remove('show');

    if (!email || !pass) {
      errEl.textContent = 'Completa los campos';
      errEl.classList.add('show');
      return;
    }

    if (STATE.demoMode || email === 'demo@pasalista.com') {
      appCore.loadDemoData?.();
      ui.initApp();
      return;
    }

    try {
      await appCore.auth.signInWithEmailAndPassword(email, pass);
      // onAuthStateChanged se encarga del resto
    } catch (e) {
      errEl.textContent = e.message;
      errEl.classList.add('show');
    }
  },

  logout() {
    if (!STATE.demoMode && appCore.auth) {
      try { appCore.auth.signOut(); } catch (e) {}
    }
    STATE.user        = null;
    STATE.userProfile = null;
    location.reload();
  }
};


function getFilteredRecords() {
  const periodo  = document.getElementById('filter-periodo')?.value  || '30';
  const grado    = document.getElementById('filter-grado')?.value    || '';
  const seccion  = document.getElementById('filter-seccion')?.value  || '';
  const estado   = document.getElementById('filter-estado')?.value   || '';

  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const hoyStr = hoy.toISOString().split('T')[0];

  let fechaMin = null;
  let fechaMax = null;

  if (periodo === 'custom') {
    fechaMin = document.getElementById('filter-desde')?.value || null;
    fechaMax = document.getElementById('filter-hasta')?.value || null;
  } else if (periodo === '1') {
    fechaMin = hoyStr; fechaMax = hoyStr;
  } else if (periodo === '2') {
    const ayer = new Date(hoy);
    ayer.setDate(ayer.getDate() - 1);
    const ayerStr = ayer.toISOString().split('T')[0];
    fechaMin = ayerStr; fechaMax = ayerStr;
  } else if (periodo !== '0') {
    const desde = new Date(hoy);
    desde.setDate(desde.getDate() - parseInt(periodo) + 1);
    fechaMin = desde.toISOString().split('T')[0];
    fechaMax = hoyStr;
  }

  let registros = [];
  Object.values(STATE.asistencias   || {}).forEach(r => registros.push({ ...r, estado: 'asistencia'   }));
  Object.values(STATE.tardanzas     || {}).forEach(r => registros.push({ ...r, estado: r.estado || 'tardanza'     }));
  Object.values(STATE.inasistencias || {}).forEach(r => registros.push({ ...r, estado: r.estado || 'inasistencia' }));

  registros = registros.filter(r => {
    const alumno = STATE.alumnos[r.alumnoId];
    if (!alumno) return false;

    const matchFecha   = (!fechaMin || r.fecha >= fechaMin) && (!fechaMax || r.fecha <= fechaMax);
    const matchGrado   = !grado   || alumno.grado   === grado;
    const matchSeccion = !seccion || alumno.seccion === seccion;
    const matchEstado  = !estado  || r.estado       === estado;

    return matchFecha && matchGrado && matchSeccion && matchEstado;
  });

  return registros;
}


appCore.init();