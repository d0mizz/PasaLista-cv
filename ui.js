const ui = {
  currentPage: 'dashboard',
  charts: {},

  initApp() {
    document.getElementById('app-loader').classList.add('hide');
    document.getElementById('login-screen').classList.add('hide');
    document.getElementById('app').classList.remove('hide');

    if (STATE.user) {
      document.getElementById('user-name').textContent = STATE.user.displayName || STATE.user.email;
      document.getElementById('user-avatar').textContent = (STATE.user.displayName || STATE.user.email).charAt(0).toUpperCase();
    }

    // Aplicar restricciones de rol si corresponde
    this.applyRoleRestrictions();

    // Hacer clic en el chip de usuario abre el perfil
    const userChip = document.querySelector('.user-chip');
    if (userChip) {
      userChip.style.cursor = 'pointer';
      userChip.onclick = () => this.openUserProfileModal();
    }

    this.updateDashboard();
    this.renderAlumnos();
    this.loadFiltros();
    this.renderReportes();
  },

  /* ─────────────────────────────────────────────
     ROLES
  ───────────────────────────────────────────── */

  isAdmin() {
    // El rol se guarda en STATE.userProfile.role ('admin' | 'operator')
    return !STATE.userProfile || STATE.userProfile.role === 'admin';
  },

  applyRoleRestrictions() {
    if (this.isAdmin()) return;

    // Ocultar páginas no permitidas para operador
    const restricted = ['alumnos', 'importar'];
    restricted.forEach(page => {
      const navItem = document.querySelector(`.nav-item[data-page="${page}"]`);
      if (navItem) navItem.style.display = 'none';
    });

    // Ocultar campos de configuración restringidos
    // Se aplica cuando se navega a configuración
  },

  applyConfigRestrictions() {
    if (this.isAdmin()) return;
    const hora = document.getElementById('cfg-hora');
    const min = document.getElementById('cfg-min');
    const btn = document.querySelector('#page-configuracion .btn.btn-primary');
    if (hora) { hora.disabled = true; hora.title = 'Solo el administrador puede cambiar este valor'; }
    if (min) { min.disabled = true; min.title = 'Solo el administrador puede cambiar este valor'; }
    if (btn) btn.style.display = 'none';
  },

  showLogin() {
    document.getElementById('app-loader').classList.add('hide');
    document.getElementById('app').classList.add('hide');
    document.getElementById('login-screen').classList.remove('hide');
  },

  navigate(page) {
    // Bloquear páginas restringidas para operadores
    if (!this.isAdmin() && ['alumnos', 'importar'].includes(page)) {
      this.showToast('No tienes permiso para acceder a esta sección', 'error');
      return;
    }

    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(`page-${page}`).classList.add('active');
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelector(`.nav-item[data-page="${page}"]`)?.classList.add('active');

    const titles = {
      dashboard: ['Dashboard', 'Resumen general del sistema'],
      alumnos: ['Alumnos', 'Gestión de estudiantes'],
      scanner: ['Escáner QR', 'Registro de asistencia'],
      importar: ['Importar', 'Carga masiva de datos'],
      reportes: ['Reportes', 'Historial y exportaciones'],
      configuracion: ['Configuración', 'Parámetros del sistema']
    };
    const [t, s] = titles[page] || [page, ''];
    document.getElementById('navbar-title').textContent = t;
    document.getElementById('navbar-sub').textContent = s;
    this.currentPage = page;

    if (page !== 'scanner' && STATE.scanner) {
      appCore.stopScanner();
    }

    if (page === 'dashboard') this.updateDashboard();
    if (page === 'alumnos') this.renderAlumnos();
    if (page === 'reportes') this.renderReportes();
    if (page === 'configuracion') setTimeout(() => this.applyConfigRestrictions(), 50);

    if (window.innerWidth <= 768) {
      document.getElementById('sidebar').classList.remove('open');
    }
  },

  toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
  },

  updateDashboard() {
    const alumnos = Object.values(STATE.alumnos);
    const totalAlumnos = alumnos.length;
    const today = new Date().toISOString().split('T')[0];

    const tardanzasHoy = Object.values(STATE.tardanzas || {}).filter(t => t.fecha === today);
    const ausentesHoy = Object.values(STATE.inasistencias || {}).filter(a => a.fecha === today);

    const cantidadTardanzas = tardanzasHoy.length;
    const cantidadAusentes = ausentesHoy.length;
    const asistieronNormal = totalAlumnos - cantidadTardanzas - cantidadAusentes;

    const cards = [
      { icon: '🎒', label: 'Total Alumnos', value: totalAlumnos, trend: 'Registrados' },
      { icon: '✅', label: 'Asistieron', value: asistieronNormal, trend: 'Llegaron a tiempo' },
      { icon: '⏰', label: 'Tardanzas', value: cantidadTardanzas, trend: 'Llegaron tarde' },
      { icon: '❌', label: 'Ausentes', value: cantidadAusentes, trend: 'No asistieron' }
    ];

    document.getElementById('stat-cards').innerHTML = cards.map(c => `
      <div class="stat-card">
        <div class="stat-icon">${c.icon}</div>
        <div class="stat-value">${c.value}</div>
        <div class="stat-label">${c.label}</div>
        <div class="stat-trend">${c.trend}</div>
      </div>
    `).join('');

    this.renderCharts();
    this.renderActivity();
    this.renderLowAttendanceChart();
  },

  /**
   * Índice de asistencia por alumno (0–100).
   * Considera los 3 tipos: a tiempo (100%), tardanza (50%), inasistencia (0%).
   * Un día = un solo registro (prioridad: inasistencia > tardanza > asistencia).
   */
  getLowAttendanceStudents(threshold = 80) {
    const byStudent = {};

    const classify = (r) => {
      const t = (r.estado || r.tipo || '').toLowerCase();
      if (t === 'inasistencia') return 'inasistencia';
      if (t === 'tardanza') return 'tardanza';
      if (t === 'asistencia') return 'asistencia';
      return null;
    };

    const addRecord = (r, fallback) => {
      if (!r?.alumnoId || !r?.fecha) return;
      const tipo = classify(r) || fallback;
      if (!tipo) return;

      if (!byStudent[r.alumnoId]) {
        byStudent[r.alumnoId] = { dias: {}, nombre: null };
      }
      const prio = { inasistencia: 3, tardanza: 2, asistencia: 1 };
      const prev = byStudent[r.alumnoId].dias[r.fecha];
      if (!prev || prio[tipo] >= prio[prev]) {
        byStudent[r.alumnoId].dias[r.fecha] = tipo;
      }
      if (!byStudent[r.alumnoId].nombre) {
        const alumno = STATE.alumnos[r.alumnoId];
        byStudent[r.alumnoId].nombre = alumno
          ? `${alumno.apellidos}, ${alumno.nombres}`
          : (r.nombre || r.alumnoId);
      }
    };

    Object.values(STATE.asistencias || {}).forEach(r => addRecord(r, 'asistencia'));
    Object.values(STATE.tardanzas || {}).forEach(r => addRecord(r, 'tardanza'));
    Object.values(STATE.inasistencias || {}).forEach(r => addRecord(r, 'inasistencia'));

    return Object.entries(byStudent)
      .map(([alumnoId, { dias, nombre }]) => {
        const counts = { asistencia: 0, tardanza: 0, inasistencia: 0 };
        Object.values(dias).forEach(t => counts[t]++);

        const total = counts.asistencia + counts.tardanza + counts.inasistencia;
        if (total === 0) return null;

        // Ponderación: a tiempo 100%, tardanza 50%, inasistencia 0%
        const puntos = counts.asistencia * 100 + counts.tardanza * 50 + counts.inasistencia * 0;
        const pct = Math.round(puntos / (total * 100) * 100);

        return {
          alumnoId,
          nombre,
          pct,
          total,
          aTiempo: counts.asistencia,
          tardanzas: counts.tardanza,
          inasistencias: counts.inasistencia
        };
      })
      .filter(Boolean)
      .filter(s => s.pct < threshold)
      .sort((a, b) => a.pct - b.pct);
  },

  renderLowAttendanceChart() {
    const canvas = document.getElementById('chart-low-attendance');
    const emptyEl = document.getElementById('low-attendance-empty');
    const badge = document.getElementById('low-attendance-badge');
    const wrap = document.querySelector('.chart-low-attendance-wrap');
    if (!canvas) return;

    const list = this.getLowAttendanceStudents(80);
    const maxBars = 12;
    const shown = list.slice(0, maxBars);

    if (badge) {
      badge.textContent = list.length === 1 ? 'Riesgo: 1 alumno' : `Riesgo: ${list.length} alumnos`;
    }

    if (emptyEl) emptyEl.classList.toggle('hide', list.length > 0);
    if (wrap) {
      wrap.classList.toggle('hide', list.length === 0);
      wrap.style.height = `${Math.max(200, shown.length * 38 + 48)}px`;
    }

    if (this.charts.lowAttendance) {
      this.charts.lowAttendance.destroy();
      this.charts.lowAttendance = null;
    }

    if (!list.length) return;

    const textColor = getComputedStyle(document.body).getPropertyValue('--text-dim').trim() || '#888';
    const labels = shown.map(s => {
      const parts = s.nombre.split(',');
      const corto = parts.length > 1
        ? `${parts[0].trim().split(' ')[0]} ${parts[1].trim().split(' ')[0]}`
        : s.nombre;
      return corto.length > 22 ? corto.slice(0, 20) + '…' : corto;
    });
    const data = shown.map(s => s.pct);

    const ctx = canvas.getContext('2d');
    this.charts.lowAttendance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: '% Asistencia',
          data,
          backgroundColor: data.map(p =>
            p < 60 ? 'rgba(192, 57, 43, 0.85)' : 'rgba(230, 126, 34, 0.85)'
          ),
          borderRadius: 6,
          barThickness: 18
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => shown[items[0].dataIndex]?.nombre || '',
              label: (ctx) => {
                const s = shown[ctx.dataIndex];
                return [
                  `Índice de asistencia: ${s.pct}%`,
                  `A tiempo: ${s.aTiempo} días`,
                  `Tardanzas: ${s.tardanzas} días`,
                  `Inasistencias: ${s.inasistencias} días`,
                  `Total: ${s.total} días registrados`
                ];
              }
            }
          }
        },
        scales: {
          x: {
            min: 0,
            max: 100,
            ticks: { color: textColor, callback: v => v + '%' },
            grid: { color: 'rgba(255,255,255,0.06)' }
          },
          y: {
            ticks: { color: textColor, font: { size: 11 } },
            grid: { display: false }
          }
        }
      }
    });

    if (list.length > maxBars && badge) {
      badge.textContent += ` (top ${maxBars})`;
    }
  },

  renderCharts() {
    const tardanzas = Object.values(STATE.tardanzas);
    const labels = [];
    const dataAsist = [];
    const dataTard = [];
    const dayNames = ['Dom','Lun','Mar','Mie','Jue','Vie','Sab'];

    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const ds = d.toISOString().split('T')[0];
      labels.push(dayNames[d.getDay()]);
      const day = tardanzas.filter(t => t.fecha === ds);
      dataAsist.push(day.filter(t => t.tipo === 'ingreso').length);
      dataTard.push(day.filter(t => t.tipo === 'tardanza').length);
    }

    if (this.charts.weekly) this.charts.weekly.destroy();
    const ctx = document.getElementById('chart-weekly').getContext('2d');
    const textColor = getComputedStyle(document.body).getPropertyValue('--text-dim');

    this.charts.weekly = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'A tiempo', data: dataAsist, backgroundColor: '#2ecc71', borderRadius: 6 },
          { label: 'Tardanzas', data: dataTard, backgroundColor: '#C0392B', borderRadius: 6 }
        ]
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: textColor } } },
        scales: {
          x: { ticks: { color: textColor }, grid: { display: false } },
          y: { ticks: { color: textColor }, grid: { color: 'rgba(255,255,255,0.05)' } }
        }
      }
    });

    if (this.charts.donut) this.charts.donut.destroy();
    const today = new Date().toISOString().split('T')[0];
    const tardanzasHoy = Object.values(STATE.tardanzas || {}).filter(t => t.fecha === today);
    const ausentesHoy = Object.values(STATE.inasistencias || {}).filter(a => a.fecha === today);
    const total = Object.keys(STATE.alumnos).length;
    const late = tardanzasHoy.length;
    const absent = ausentesHoy.length;
    const onTime = total - late - absent;

    const ctx2 = document.getElementById('chart-donut').getContext('2d');
    this.charts.donut = new Chart(ctx2, {
      type: 'doughnut',
      data: {
        labels: ['A tiempo', 'Tardanzas', 'Ausentes'],
        datasets: [{
          data: [onTime, late, absent],
          backgroundColor: ['#2ecc71', '#C0392B', '#3a3a5a'],
          borderWidth: 0
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'bottom', labels: { color: textColor, padding: 14 } } },
        cutout: '65%'
      }
    });
  },

  renderActivity() {
    const recent = Object.values(STATE.tardanzas)
      .sort((a, b) => (b.fecha + b.hora).localeCompare(a.fecha + a.hora))
      .slice(0, 5);
    const html = recent.length ? recent.map(t => `
      <div class="activity-item">
        <div class="activity-dot ${t.tipo === 'tardanza' ? 'late' : ''}"></div>
        <div class="activity-text">${t.nombre}</div>
        <div class="activity-time">${t.fecha} · ${t.hora}</div>
      </div>
    `).join('') : '<div class="empty-state">Sin actividad reciente</div>';
    document.getElementById('recent-activity').innerHTML = html;
  },

  renderAlumnos() {
    const q = (document.getElementById('search-alumnos')?.value || '').toLowerCase();
    const tbody = document.getElementById('alumnos-tbody');
    if (!tbody) return;
    const list = Object.values(STATE.alumnos).filter(a => {
      if (!q) return true;
      return [a.codigo, a.nombres, a.apellidos, a.grado, a.seccion].join(' ').toLowerCase().includes(q);
    });

    tbody.innerHTML = list.length ? list.map(a => `
      <tr>
        <td><span class="code-cell">${a.codigo}</span></td>
        <td>${a.apellidos}</td>
        <td>${a.nombres}</td>
        <td>${a.grado || '-'}</td>
        <td>${a.seccion || '-'}</td>
        <td><span class="badge ${a.activo ? 'badge-success' : 'badge-danger'}">${a.activo ? 'Activo' : 'Inactivo'}</span></td>
        <td>
          ${qrModule.hasQR(a)
            ? `<button class="row-action" onclick="ui.openQRModal('${a.id}')">Ver QR</button>`
            : `<button class="row-action" onclick="ui.generateSingleQR('${a.id}')">Generar</button>`}
        </td>
        <td><button class="row-action" onclick="appCore.deleteAlumno('${a.id}')">Eliminar</button></td>
      </tr>
    `).join('') : `<tr><td colspan="8"><div class="empty-state">No hay alumnos. Importa o agrega manualmente.</div></td></tr>`;
  },

  GRADOS_CONFIG: {
    'Inicial':     ['2A','3A','4A','5A'],
    '1 Primaria':  ['A','B','C','D'],
    '2 Primaria':  ['A','B','C','D'],
    '3 Primaria':  ['A','B','C'],
    '4 Primaria':  ['A','B','C'],
    '5 Primaria':  ['A','B','C'],
    '6 Primaria':  ['A','B','C'],
  },

  loadFiltros() {
    const gradoSelect   = document.getElementById('filter-grado');
    const seccionSelect = document.getElementById('filter-seccion');
    const periodoSelect = document.getElementById('filter-periodo');
    const customRange   = document.getElementById('filter-custom-range');
    if (!gradoSelect || !seccionSelect) return;

    if (periodoSelect) {
      periodoSelect.addEventListener('change', () => {
        customRange.style.display = periodoSelect.value === 'custom' ? 'flex' : 'none';
      });
    }

    gradoSelect.innerHTML =
      `<option value="">Todos los grados</option>` +
      Object.keys(this.GRADOS_CONFIG).map(g =>
        `<option value="${g}">${g}</option>`
      ).join('');

    const updateSecciones = () => {
      const grado = gradoSelect.value;
      const secciones = this.GRADOS_CONFIG[grado] || [];
      if (!grado || secciones.length === 0) {
        seccionSelect.innerHTML = `<option value="">Todas las secciones</option>`;
        seccionSelect.disabled = true;
      } else {
        seccionSelect.innerHTML =
          `<option value="">Todas las secciones</option>` +
          secciones.map(s => `<option value="${s}">${s}</option>`).join('');
        seccionSelect.disabled = false;
      }
    };

    gradoSelect.addEventListener('change', updateSecciones);
    updateSecciones();

    const btnFiltrar = document.getElementById('btn-filtrar');
    if (btnFiltrar) {
      btnFiltrar.onclick = () => this.renderReportes();
    }
  },

  renderReportes() {
    const tbody = document.getElementById('reportes-tbody');
    if (!tbody) return;

    const registros = getFilteredRecords().sort((a, b) =>
      (b.fecha + (b.hora || '')).localeCompare(a.fecha + (a.hora || ''))
    );

    tbody.innerHTML = registros.length
      ? registros.map(r => {
          const alumno = STATE.alumnos[r.alumnoId];
          return `
            <tr>
              <td>${r.fecha}</td>
              <td>${r.nombre}</td>
              <td>${alumno?.grado || '-'}</td>
              <td>${alumno?.seccion || '-'}</td>
              <td>${r.hora || '-'}</td>
              <td>
                <span class="badge
                  ${r.estado === 'tardanza'
                    ? 'badge-danger'
                    : r.estado === 'inasistencia'
                    ? 'badge-dark'
                    : 'badge-success'}">
                  ${r.estado}
                </span>
              </td>
              <td>${r.justificacion || '-'}</td>
            </tr>
          `;
        }).join('')
      : `<tr><td colspan="7"><div class="empty-state">Sin registros</div></td></tr>`;
  },

  addScanFeed(data) {
    const feed = document.getElementById('scan-feed');
    if (feed.querySelector('.empty-state')) feed.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'activity-item';
    div.innerHTML = `
      <div class="activity-dot ${data.tipo === 'tardanza' ? 'late' : ''}"></div>
      <div class="activity-text">${data.nombre}</div>
      <div class="activity-time">${data.hora}</div>
    `;
    feed.insertBefore(div, feed.firstChild);
    this.updateDashboard();
  },

  showToast(msg, type = 'info') {
    const c = document.getElementById('toast-container');
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(() => {
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 300);
    }, 3000);
  },

  toggleTheme() {
    const html = document.documentElement;
    const cur = html.dataset.theme;
    html.dataset.theme = cur === 'light' ? 'dark' : 'light';
    setTimeout(() => {
      this.renderCharts();
      this.renderLowAttendanceChart();
    }, 100);
  },

  openAlumnoModal() {
    const gradoOptions = Object.keys(this.GRADOS_CONFIG)
      .map(g => `<option value="${g}">${g}</option>`).join('');

    const root = document.getElementById('modal-root');
    root.innerHTML = `
      <div class="modal-backdrop" onclick="if(event.target===this)ui.closeModal()">
        <div class="modal-content glass">
          <div class="modal-title">Nuevo Alumno</div>
          <div class="form-group"><label class="form-label">Código</label><input class="form-input" id="m-codigo"/></div>
          <div class="form-group"><label class="form-label">Apellidos</label><input class="form-input" id="m-apellidos"/></div>
          <div class="form-group"><label class="form-label">Nombres</label><input class="form-input" id="m-nombres"/></div>
          <div class="form-group">
            <label class="form-label">Grado</label>
            <select class="form-input" id="m-grado" onchange="ui.updateModalSecciones()">
              <option value="">Selecciona un grado</option>
              ${gradoOptions}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Sección</label>
            <select class="form-input" id="m-seccion" disabled>
              <option value="">— sin sección —</option>
            </select>
          </div>
          <div class="modal-actions">
            <button class="btn btn-ghost" onclick="ui.closeModal()">Cancelar</button>
            <button class="btn btn-primary" onclick="ui.submitAlumno()">Guardar</button>
          </div>
        </div>
      </div>
    `;
  },

  updateModalSecciones() {
    const grado = document.getElementById('m-grado').value;
    const seccionSelect = document.getElementById('m-seccion');
    const secciones = this.GRADOS_CONFIG[grado] || [];
    if (secciones.length === 0) {
      seccionSelect.innerHTML = `<option value="">— sin sección —</option>`;
      seccionSelect.disabled = true;
    } else {
      seccionSelect.innerHTML = secciones.map(s => `<option value="${s}">${s}</option>`).join('');
      seccionSelect.disabled = false;
    }
  },

  async submitAlumno() {
    const data = {
      codigo: document.getElementById('m-codigo').value.trim(),
      apellidos: document.getElementById('m-apellidos').value.trim(),
      nombres: document.getElementById('m-nombres').value.trim(),
      grado: document.getElementById('m-grado').value.trim(),
      seccion: document.getElementById('m-seccion').value.trim()
    };
    if (!data.codigo || !data.apellidos || !data.nombres) {
      this.showToast('Completa los campos requeridos', 'error');
      return;
    }
    this.closeModal();
    await appCore.addAlumno(data);
  },

  async generateSingleQR(alumnoId) {
    const alumno = STATE.alumnos[alumnoId];
    if (!alumno) return;
    this.showToast('Generando QR...', 'info');
    try {
      await qrModule.generateForAlumno(alumno);
      this.showToast(`QR listo para ${alumno.nombres}`, 'success');
      this.renderAlumnos();
    } catch (e) {
      this.showToast('Error: ' + e.message, 'error');
    }
  },

  async generateAllQR() {
    const total = Object.values(STATE.alumnos).length;
    if (!total) {
      this.showToast('No hay alumnos registrados', 'error');
      return;
    }
    if (!confirm(`¿Generar códigos QR para ${total} alumnos? Esto puede tardar un momento.`)) return;

    const btn = document.getElementById('btn-gen-all-qr');
    if (btn) { btn.disabled = true; btn.textContent = 'Generando...'; }

    try {
      const res = await qrModule.generateAll((done, all) => {
        if (btn) btn.textContent = `Generando ${done}/${all}...`;
      });
      this.showToast(`Listo: ${res.ok} QR generados${res.fail ? `, ${res.fail} fallaron` : ''}`, res.fail ? 'info' : 'success');
      this.renderAlumnos();
    } catch (e) {
      this.showToast('Error: ' + e.message, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '📱 Generar todos los QR';
      }
    }
  },

  openQRModal(alumnoId) {
    const alumno = STATE.alumnos[alumnoId];
    if (!alumno) return;

    const url = alumno.qr?.url;
    const root = document.getElementById('modal-root');
    root.innerHTML = `
      <div class="modal-backdrop" onclick="if(event.target===this)ui.closeModal()">
        <div class="modal-content glass qr-modal">
          <div class="modal-title">Código QR — ${alumno.nombres} ${alumno.apellidos}</div>
          <p class="muted">Código de alumno: <strong>${alumno.codigo}</strong></p>
          <div class="qr-preview-wrap">
            ${url
              ? `<img src="${url}" alt="QR ${alumno.codigo}" class="qr-preview-img"/>`
              : `<div class="empty-state">Sin imagen QR</div>`}
          </div>
          <div class="modal-actions">
            <button class="btn btn-ghost" onclick="ui.closeModal()">Cerrar</button>
            ${url ? `<a class="btn btn-primary" href="${url}" download="QR_${alumno.codigo}.png" target="_blank">Descargar</a>` : ''}
            <button class="btn btn-ghost" onclick="ui.generateSingleQR('${alumnoId}');ui.closeModal()">Regenerar</button>
          </div>
        </div>
      </div>
    `;
  },

  closeModal() {
    document.getElementById('modal-root').innerHTML = '';
  },

  openJustificacionModal(code, alumnoPre = null) {
    const safeCode = String(code || '').replace(/'/g, "\\'");
    const alumno = alumnoPre || appCore.findAlumnoByCodigo(code);
    const root = document.getElementById('modal-root');
    if (!root) return;
    root.innerHTML = `
      <div class="modal-backdrop show" onclick="if(event.target===this)ui.closeModal()">
        <div class="modal-content glass">
          <div class="modal-title">Registrar asistencia</div>
          ${alumno ? `
          <div class="scan-alumno-chip">
            <div style="font-weight:600">${alumno.apellidos}, ${alumno.nombres}</div>
            <div style="font-size:12px;color:var(--text-dim)">Código: ${alumno.codigo} · ${alumno.grado || ''} ${alumno.seccion || ''}</div>
          </div>
          ` : ''}

          <div class="form-group">
            <label class="form-label">Tipo de registro</label>
            <div style="display:flex;gap:10px;margin-top:4px;">
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1;padding:10px 14px;border:2px solid var(--border);border-radius:10px;transition:border-color .2s" id="lbl-tipo-tardanza">
                <input type="radio" name="tipo-registro" value="tardanza" checked onchange="ui._updateTipoLabel()" style="accent-color:var(--accent)"/>
                ⏰ Tardanza
              </label>
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1;padding:10px 14px;border:2px solid var(--border);border-radius:10px;transition:border-color .2s" id="lbl-tipo-inasistencia">
                <input type="radio" name="tipo-registro" value="inasistencia" onchange="ui._updateTipoLabel()" style="accent-color:var(--accent)"/>
                ❌ Inasistencia
              </label>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">Justificación (Opcional)</label>
            <textarea id="txt-justificacion" class="form-input" style="min-height:120px" placeholder="Escribe una justificación..."></textarea>
          </div>

          <div class="modal-actions">
            <button class="btn btn-ghost" onclick="ui.closeModal()">Cancelar</button>
            <button class="btn btn-primary" onclick="ui.confirmScan('${safeCode}')">Registrar</button>
          </div>
        </div>
      </div>
    `;
    this._updateTipoLabel();
  },

  _updateTipoLabel() {
    const radios = document.querySelectorAll('input[name="tipo-registro"]');
    radios.forEach(r => {
      const lbl = r.closest('label');
      if (lbl) lbl.style.borderColor = r.checked ? 'var(--accent)' : 'var(--border)';
    });
  },

  async confirmScan(code) {
    const justificacion = document.getElementById('txt-justificacion').value;
    const tipoRadio = document.querySelector('input[name="tipo-registro"]:checked');
    const tipoForzado = tipoRadio ? tipoRadio.value : null;

    const res = await appCore.processScan(code, justificacion, tipoForzado);

    if (res.success) {
      ui.showToast(`✓ ${res.alumno.nombres} registrado`, 'success');
      ui.addScanFeed(res.data);
    } else {
      ui.showToast(res.msg, 'error');
    }
    ui.closeModal();
  },

  openManualRegistro() {
    const root = document.getElementById('modal-root');
    root.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal-content glass">
          <div class="modal-title">Registro Manual</div>
          <div class="form-group">
            <label class="form-label">Buscar alumno</label>
            <input type="text" id="manual-search" class="form-input" placeholder="Código o nombre..." oninput="ui.searchManualAlumno()"/>
          </div>
          <div id="manual-results" style="max-height:300px;overflow:auto;display:flex;flex-direction:column;gap:8px;"></div>
          <div class="modal-actions">
            <button class="btn btn-ghost" onclick="ui.closeModal()">Cerrar</button>
          </div>
        </div>
      </div>
    `;
  },

  searchManualAlumno() {
    const q = document.getElementById('manual-search').value.toLowerCase().trim();
    const results = document.getElementById('manual-results');
    if (!q) { results.innerHTML = ''; return; }

    const alumnos = Object.values(STATE.alumnos).filter(a =>
      a.codigo.toLowerCase().includes(q) ||
      a.nombres.toLowerCase().includes(q) ||
      a.apellidos.toLowerCase().includes(q)
    ).slice(0, 20);

    if (!alumnos.length) {
      results.innerHTML = `<div class="empty-state">No se encontraron alumnos</div>`;
      return;
    }

    results.innerHTML = alumnos.map(a => `
      <div class="activity-item">
        <div style="flex:1">
          <div style="font-weight:600">${a.apellidos}, ${a.nombres}</div>
          <div class="activity-time">${a.codigo} · ${a.grado} ${a.seccion}</div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="ui.manualSelectAlumno('${a.codigo}')">Seleccionar</button>
      </div>
    `).join('');
  },

  manualSelectAlumno(codigo) {
    const alumno = appCore.findAlumnoByCodigo(codigo);
    if (!alumno) return;

    const root = document.getElementById('modal-root');
    root.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal-content glass">
          <div class="modal-title">Registro Manual</div>

          <div class="activity-item" style="margin-bottom:14px">
            <div style="flex:1">
              <div style="font-weight:600">${alumno.apellidos}, ${alumno.nombres}</div>
              <div class="activity-time">${alumno.codigo} · ${alumno.grado} ${alumno.seccion}</div>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">Tipo de registro</label>
            <div style="display:flex;gap:10px;margin-top:4px;">
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1;padding:10px 14px;border:2px solid var(--accent);border-radius:10px;transition:border-color .2s" id="lbl-m-tardanza">
                <input type="radio" name="manual-tipo" value="tardanza" checked onchange="ui._updateManualTipoLabel()" style="accent-color:var(--accent)"/>
                ⏰ Tardanza
              </label>
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1;padding:10px 14px;border:2px solid var(--border);border-radius:10px;transition:border-color .2s" id="lbl-m-inasistencia">
                <input type="radio" name="manual-tipo" value="inasistencia" onchange="ui._updateManualTipoLabel()" style="accent-color:var(--accent)"/>
                ❌ Inasistencia
              </label>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">Justificación (Opcional)</label>
            <textarea id="manual-justificacion" class="form-input" style="min-height:100px" placeholder="Escribe una justificación..."></textarea>
          </div>

          <div class="modal-actions">
            <button class="btn btn-ghost" onclick="ui.openManualRegistro()">← Volver</button>
            <button class="btn btn-primary" onclick="ui.confirmManualRegistro('${codigo}')">Registrar</button>
          </div>
        </div>
      </div>
    `;
  },

  _updateManualTipoLabel() {
    const radios = document.querySelectorAll('input[name="manual-tipo"]');
    radios.forEach(r => {
      const lbl = r.closest('label');
      if (lbl) lbl.style.borderColor = r.checked ? 'var(--accent)' : 'var(--border)';
    });
  },

  async confirmManualRegistro(codigo) {
    const justificacion = document.getElementById('manual-justificacion').value;
    const tipoRadio = document.querySelector('input[name="manual-tipo"]:checked');
    const tipoForzado = tipoRadio ? tipoRadio.value : 'tardanza';

    const res = await appCore.processScan(codigo, justificacion, tipoForzado);

    if (res.success) {
      ui.showToast(
        tipoForzado === 'inasistencia' ? 'Inasistencia registrada' : 'Tardanza registrada',
        'success'
      );
      ui.addScanFeed(res.data);
      ui.closeModal();
    } else {
      ui.showToast(res.msg, 'error');
    }
  },

  /* ─────────────────────────────────────────────
     PERFIL DE USUARIO
  ───────────────────────────────────────────── */

  openUserProfileModal() {
    const user = STATE.user;
    const profile = STATE.userProfile || {};
    const displayName = user?.displayName || profile.displayName || '';
    const email = user?.email || '';
    const isAdmin = this.isAdmin();

    const root = document.getElementById('modal-root');
    root.innerHTML = `
      <div class="modal-backdrop" onclick="if(event.target===this)ui.closeModal()">
        <div class="modal-content glass" style="max-width:420px">
          <div class="modal-title">Mi Perfil</div>

          <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px;padding:14px;background:var(--surface2);border-radius:12px;">
            <div style="width:52px;height:52px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;color:#fff;flex-shrink:0;">
              ${displayName.charAt(0).toUpperCase() || email.charAt(0).toUpperCase()}
            </div>
            <div>
              <div style="font-weight:600;font-size:15px">${displayName || 'Sin nombre'}</div>
              <div style="font-size:12px;color:var(--text-dim)">${email}</div>
              <div style="margin-top:4px">
                <span class="badge ${isAdmin ? 'badge-success' : ''}">
                  ${isAdmin ? '👑 Administrador' : '👤 Operador'}
                </span>
              </div>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">Nombre para mostrar</label>
            <input type="text" id="prof-displayname" class="form-input" value="${displayName}" placeholder="Tu nombre completo"/>
          </div>

          <div class="form-group">
            <label class="form-label">Correo electrónico</label>
            <input type="email" id="prof-email" class="form-input" value="${email}" disabled style="opacity:.6;cursor:not-allowed;" title="No se puede cambiar el correo aquí"/>
          </div>

          <div class="form-group">
            <label class="form-label">Nueva contraseña <span style="font-size:11px;color:var(--text-dim)">(dejar vacío para no cambiar)</span></label>
            <input type="password" id="prof-pass" class="form-input" placeholder="••••••••"/>
          </div>

          ${isAdmin ? `
          <hr style="border-color:var(--border);margin:16px 0;"/>
          <button class="btn btn-ghost btn-block" onclick="ui.closeModal();setTimeout(()=>ui.openUserManagementModal(),100)">
            👥 Gestionar usuarios del sistema
          </button>
          ` : ''}

          <div class="modal-actions" style="margin-top:16px">
            <button class="btn btn-ghost" onclick="ui.closeModal()">Cancelar</button>
            <button class="btn btn-primary" onclick="ui.saveUserProfile()">Guardar cambios</button>
          </div>
        </div>
      </div>
    `;
  },

  async saveUserProfile() {
    const newName = document.getElementById('prof-displayname').value.trim();
    const newPass = document.getElementById('prof-pass').value;

    if (!newName) {
      this.showToast('El nombre no puede estar vacío', 'error');
      return;
    }

    try {
      const user = firebase.auth().currentUser;

      // Actualizar displayName en Firebase Auth
      await user.updateProfile({ displayName: newName });

      // Actualizar en Realtime Database bajo /usuarios/{uid}
      await firebase.database().ref(`usuarios/${user.uid}`).update({ displayName: newName });

      // Actualizar contraseña si se ingresó una
      if (newPass) {
        if (newPass.length < 6) {
          this.showToast('La contraseña debe tener al menos 6 caracteres', 'error');
          return;
        }
        await user.updatePassword(newPass);
      }

      // Actualizar UI local
      document.getElementById('user-name').textContent = newName;
      document.getElementById('user-avatar').textContent = newName.charAt(0).toUpperCase();
      if (STATE.userProfile) STATE.userProfile.displayName = newName;

      this.showToast('Perfil actualizado correctamente', 'success');
      this.closeModal();
    } catch (err) {
      console.error(err);
      if (err.code === 'auth/requires-recent-login') {
        this.showToast('Vuelve a iniciar sesión para cambiar la contraseña', 'error');
      } else {
        this.showToast('Error al guardar: ' + err.message, 'error');
      }
    }
  },

  /* ─────────────────────────────────────────────
     GESTIÓN DE USUARIOS (solo admin)
  ───────────────────────────────────────────── */

  async openUserManagementModal() {
    if (!this.isAdmin()) {
      this.showToast('Acceso denegado', 'error');
      return;
    }

    const root = document.getElementById('modal-root');
    root.innerHTML = `
      <div class="modal-backdrop" onclick="if(event.target===this)ui.closeModal()">
        <div class="modal-content glass" style="max-width:520px">
          <div class="modal-title">👥 Gestión de Usuarios</div>
          <div id="user-list-container">
            <div class="empty-state">Cargando usuarios...</div>
          </div>
          <hr style="border-color:var(--border);margin:16px 0;"/>
          <div style="font-weight:600;margin-bottom:12px;font-size:14px">➕ Crear nuevo usuario operador</div>
          <div class="form-group">
            <label class="form-label">Nombre completo</label>
            <input type="text" id="new-user-name" class="form-input" placeholder="Nombre del usuario"/>
          </div>
          <div class="form-group">
            <label class="form-label">Correo electrónico</label>
            <input type="email" id="new-user-email" class="form-input" placeholder="correo@ejemplo.com"/>
          </div>
          <div class="form-group">
            <label class="form-label">Contraseña inicial</label>
            <input type="password" id="new-user-pass" class="form-input" placeholder="Mínimo 6 caracteres"/>
          </div>
          <div class="modal-actions">
            <button class="btn btn-ghost" onclick="ui.closeModal()">Cerrar</button>
            <button class="btn btn-primary" onclick="ui.createOperatorUser()">Crear usuario</button>
          </div>
        </div>
      </div>
    `;

    // Cargar lista de usuarios desde Firebase
    this._loadUserList();
  },

  async _loadUserList() {
    const container = document.getElementById('user-list-container');
    if (!container) return;

    try {
      const snap = await firebase.database().ref('usuarios').once('value');
      const usuarios = snap.val() || {};
      const list = Object.entries(usuarios);

      if (!list.length) {
        container.innerHTML = `<div class="empty-state">No hay usuarios registrados aún.</div>`;
        return;
      }

      container.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:8px;max-height:220px;overflow:auto;">
          ${list.map(([uid, u]) => `
            <div style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:var(--surface2);border-radius:10px;">
              <div style="width:36px;height:36px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff;flex-shrink:0;font-size:15px;">
                ${(u.displayName || u.email || '?').charAt(0).toUpperCase()}
              </div>
              <div style="flex:1;min-width:0;">
                <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${u.displayName || 'Sin nombre'}</div>
                <div style="font-size:11px;color:var(--text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${u.email}</div>
              </div>
              <span class="badge ${u.role === 'admin' ? 'badge-success' : ''}">
                ${u.role === 'admin' ? '👑 Admin' : '👤 Operador'}
              </span>
              ${u.role !== 'admin' ? `
              <button class="row-action" style="color:#e74c3c" onclick="ui._deleteUser('${uid}')">Eliminar</button>
              ` : ''}
            </div>
          `).join('')}
        </div>
      `;
    } catch (err) {
      container.innerHTML = `<div class="empty-state">Error al cargar usuarios: ${err.message}</div>`;
    }
  },

  async createOperatorUser() {
    const name  = document.getElementById('new-user-name').value.trim();
    const email = document.getElementById('new-user-email').value.trim();
    const pass  = document.getElementById('new-user-pass').value;

    if (!name || !email || !pass) {
      this.showToast('Completa todos los campos', 'error');
      return;
    }
    if (pass.length < 6) {
      this.showToast('La contraseña debe tener al menos 6 caracteres', 'error');
      return;
    }

    try {
      // Crear usuario secundario con Firebase Auth
      // Guardamos el usuario actual para restaurarlo después
      const currentUser = firebase.auth().currentUser;
      const currentEmail = currentUser.email;

      // Usamos una instancia secundaria de la app para no desloguear al admin
      let secondaryApp;
      try {
        secondaryApp = firebase.app('secondary');
      } catch (_) {
        secondaryApp = firebase.initializeApp(firebase.app().options, 'secondary');
      }

      const secondaryAuth = secondaryApp.auth();
      const cred = await secondaryAuth.createUserWithEmailAndPassword(email, pass);
      const newUid = cred.user.uid;
      await cred.user.updateProfile({ displayName: name });
      await secondaryAuth.signOut();

      // Guardar perfil en el nodo /usuarios/{uid} con role: 'operator'
      const perfil = {
        uid: newUid,
        displayName: name,
        email: email,
        role: 'operator',
        permisos: {
          dashboard: true,
          scanner: true,
          reportes: true,
          configuracion: true,
          alumnos: false,
          importar: false,
          editarConfiguracion: false   // no puede editar hora/min asistencia
        },
        creadoEn: new Date().toISOString()
      };
      await firebase.database().ref(`usuarios/${newUid}`).set(perfil);

      // Limpiar campos
      document.getElementById('new-user-name').value = '';
      document.getElementById('new-user-email').value = '';
      document.getElementById('new-user-pass').value = '';

      this.showToast(`Usuario "${name}" creado correctamente`, 'success');
      this._loadUserList();
    } catch (err) {
      console.error(err);
      if (err.code === 'auth/email-already-in-use') {
        this.showToast('Ese correo ya está registrado', 'error');
      } else {
        this.showToast('Error: ' + err.message, 'error');
      }
    }
  },

  async _deleteUser(uid) {
    if (!confirm('¿Eliminar este usuario del sistema? Esta acción no se puede deshacer.')) return;
    try {
      await firebase.database().ref(`usuarios/${uid}`).remove();
      this.showToast('Usuario eliminado', 'success');
      this._loadUserList();
    } catch (err) {
      this.showToast('Error al eliminar: ' + err.message, 'error');
    }
  }
};

const dropArea = document.getElementById('drop-area');
if (dropArea) {
  ['dragover','dragenter'].forEach(ev => dropArea.addEventListener(ev, e => { e.preventDefault(); dropArea.classList.add('drag'); }));
  ['dragleave','drop'].forEach(ev => dropArea.addEventListener(ev, e => { e.preventDefault(); dropArea.classList.remove('drag'); }));
  dropArea.addEventListener('drop', e => {
    const file = e.dataTransfer.files[0];
    if (file) appCore.handleFile({ target: { files: [file] } });
  });
}