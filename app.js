/* ===========================
   CONFIG — CHANGE THESE
   =========================== */
const SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vTlv6QJ03KC1bqTbshjE8ykrBPiz7ki5yZ0HjR6Q7wa6L6PObaPNLjBPhnBSa7yU7i5SkIrJx4Ddkhz/pub?gid=0&single=true&output=csv";

const ID_COLUMN       = "StandID";
const STATUS_COLUMN   = "Status";
const SIZE_COLUMN     = "Size";
const PRICE_COLUMN    = "Price";
const UPDATED_COLUMN  = "LastUpdated";   // <- read from sheet, show only at bottom

// If you fetch polygons from a file, set it here; otherwise leave "" and use inline JSON.
const POLYGONS_JSON_URL = "polygons.json";

const COLORS = {
  available:   "#2ecc71",
  reserved:    "#f4b400",
  unavailable: "#d93025",
  unknown:     "#9ea3a8"
};
const FILL_OPACITY = 0.35;

// Fine-tune alignment if needed later
const ALIGN_TWEAK = { scale: 0.744, dx: 475, dy: -105, rotateDeg: 0 };

/* ===========================
   RUNTIME ELEMENTS
   =========================== */
const svg     = document.getElementById("mapSvg");
const details = document.getElementById("details");
let lockedId  = "";

/* ===========================
   HELPERS
   =========================== */
const norm = s => String(s ?? "").trim().toLowerCase();

const statusKey = s => {
  const t = norm(s);
  if (t.startsWith("avail")) return "available";
  if (t.startsWith("reser") || t === "pending") return "reserved";
  if (t.startsWith("unavail")) return "unavailable";
  return "unknown";
};

function parseCSV(text) {
  const rows = []; let row = [], field = "", inQ = false;
  for (let i=0;i<text.length;i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i+1] === '"') { field += '"'; i++; }
        else { inQ = false; }
      } else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field=""; }
      else if (c === "\r") {} else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function formatSAST(isoLike) {
  if (!isoLike) return "";
  // Accept "YYYY-MM-DDTHH:mm:ss" or "YYYY-MM-DD HH:mm:ss"
  const d = new Date(String(isoLike).trim().replace(" ", "T"));
  if (Number.isNaN(+d)) return String(isoLike);
  return new Intl.DateTimeFormat("en-ZA", {
    timeZone: "Africa/Johannesburg",
    year: "numeric", month: "long", day: "2-digit",
    hour: "2-digit", minute: "2-digit"
  }).format(d) + " SAST";
}

/* ===========================
   ARTWORK / POLYGON MAPPING
   =========================== */
function getPolysLayer(){
  let layer = svg.querySelector('#polys-layer');
  if(!layer){
    const vp = svg.querySelector('#viewport') || svg;
    layer = document.createElementNS(svg.namespaceURI, 'g');
    layer.setAttribute('id','polys-layer');
    vp.appendChild(layer);
  }
  return layer;
}

function getPlanNode() {
  let n = svg.querySelector('#siteplan');
  if (n) return n;

  const images = [...svg.querySelectorAll('image')];
  if (images.length) {
    const bestImg = images.reduce((best, im) => {
      const w = im.width?.baseVal?.value || +im.getAttribute('width') || 0;
      const h = im.height?.baseVal?.value || +im.getAttribute('height') || 0;
      const sBest = (best.width?.baseVal?.value || +best.getAttribute('width') || 0) *
                    (best.height?.baseVal?.value || +best.getAttribute('height') || 0);
      const sThis = w * h;
      return sThis > sBest ? im : best;
    }, images[0]);
    return bestImg.closest('g') || bestImg;
  }
  n = svg.querySelector('g[clip-path]');
  if (n) return n;
  return svg;
}

function artworkBBox() {
  const node = getPlanNode();
  if (!node || !node.getBBox) {
    const vb = svg.viewBox?.baseVal || { x:0, y:0, width:100, height:100 };
    return { x: vb.x, y: vb.y, width: vb.width, height: vb.height };
  }
  const bb = node.getBBox();
  if (!isFinite(bb.width) || !isFinite(bb.height) || bb.width === 0 || bb.height === 0) {
    const vb = svg.viewBox?.baseVal || { x:0, y:0, width:100, height:100 };
    return { x: vb.x, y: vb.y, width: vb.width, height: vb.height };
  }
  return bb;
}

function polygonsBBox(polys) {
  let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
  polys.forEach(({points}) => {
    points.trim().split(/\s+/).forEach(pair => {
      const [x,y] = pair.split(',').map(Number);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        if (x<minX) minX=x; if (y<minY) minY=y;
        if (x>maxX) maxX=x; if (y>maxY) maxY=y;
      }
    });
  });
  return { minX, minY, maxX, maxY, width:maxX-minX, height:maxY-minY };
}

function fitSvgToArtwork() {
  const bb = artworkBBox();
  svg.setAttribute('viewBox', `${bb.x} ${bb.y} ${bb.width} ${bb.height}`);
}

function remapPolygonsToArtwork(polys) {
  const src = polygonsBBox(polys);
  const dst = artworkBBox();
  if (!isFinite(src.width) || !isFinite(src.height) || src.width <= 0 || src.height <= 0) return polys;

  let s = Math.min(dst.width / src.width, dst.height / src.height);
  s *= ALIGN_TWEAK.scale;

  const scaledW = src.width * s, scaledH = src.height * s;
  const tx = dst.x + (dst.width  - scaledW)/2 - src.minX * s;
  const ty = dst.y + (dst.height - scaledH)/2 - src.minY * s;

  const cx = dst.x + dst.width / 2;
  const cy = dst.y + dst.height / 2;
  const rad = ALIGN_TWEAK.rotateDeg * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);

  return polys.map(({ id, points }) => ({
    id,
    points: points.trim().split(/\s+/).map(pair => {
      let [x, y] = pair.split(',').map(Number);
      let X = x * s + tx;
      let Y = y * s + ty;
      if (ALIGN_TWEAK.rotateDeg) {
        const dx = X - cx, dy = Y - cy;
        X = dx * cos - dy * sin + cx;
        Y = dx * sin - dy * cos + cy;
      }
      X += ALIGN_TWEAK.dx;
      Y += ALIGN_TWEAK.dy;
      return `${X},${Y}`;
    }).join(' ')
  }));
}

/* ===========================
   SHEET & POLYGONS LOAD
   =========================== */
async function loadSheet() {
  if (!SHEET_CSV_URL) return { statusMap:{}, lastUpdated:"" };
  const res  = await fetch(SHEET_CSV_URL, { cache: "no-store" });
  const text = await res.text();

  const rows = parseCSV(text);
  if (!rows.length) return { statusMap:{}, lastUpdated:"" };

  const headers = rows[0].map(h => h.trim());
  const idx = {
    id:      headers.findIndex(h => norm(h) === norm(ID_COLUMN)),
    status:  headers.findIndex(h => norm(h) === norm(STATUS_COLUMN)),
    updated: headers.findIndex(h => norm(h) === norm(UPDATED_COLUMN))
  };

  // Pull *one* timestamp from the LastUpdated column (first non-empty cell)
  let lastUpdatedVal = "";
  if (idx.updated >= 0) {
    for (let r = 1; r < rows.length; r++) {
      const v = rows[r][idx.updated];
      if (v && String(v).trim()) { lastUpdatedVal = String(v).trim(); break; }
    }
  }

  // Build the status map
  const map = {};
  for (let r=1; r<rows.length; r++) {
    const row   = rows[r];
    const idVal = row[idx.id] ?? "";
    const sVal  = row[idx.status] ?? "";
    if (!idVal) continue;
    map[norm(idVal)] = {
      id: String(idVal).trim(),
      status: statusKey(sVal),
      rawStatus: sVal,
      row: Object.fromEntries(headers.map((h,i)=>[h,row[i]]))
    };
  }
  return { statusMap: map, lastUpdated: lastUpdatedVal };
}

async function loadPolygons(){
  if (POLYGONS_JSON_URL){
    const res = await fetch(POLYGONS_JSON_URL, { cache:'no-store' });
    const data = await res.json();
    return Array.isArray(data.polygons) ? data.polygons : [];
  }
  const inline = document.getElementById('polygons-data');
  if (inline && inline.textContent.trim()){
    try {
      const data = JSON.parse(inline.textContent);
      return Array.isArray(data.polygons) ? data.polygons : [];
    } catch (e){
      console.error('Polygons inline JSON parse error:', e);
      alert('Polygons JSON is not valid. Check for trailing commas or stray text.');
      return [];
    }
  }
  return [];
}

/* ===========================
   DRAWING & INTERACTION
   =========================== */
function colorForStatus(key) { return COLORS[key] || COLORS.unknown; }

function makePolygon({ id: polyId, points }, statusMap) {
  const svgNS = "http://www.w3.org/2000/svg";
  const p = document.createElementNS(svgNS, "polygon");
  p.setAttribute("points", points);
  if (polyId) p.setAttribute("id", polyId);

  const rec =
    statusMap[norm(polyId || "")] ||
    statusMap[norm((polyId || "").replace(/^stand-/, ""))] ||
    null;
  const stat = rec ? rec.status : "unknown";

  p.style.fill = (COLORS[stat] || COLORS.unknown);
  p.style.fillOpacity = FILL_OPACITY;
  p.style.stroke = "#000";
  p.style.strokeOpacity = 0.35;
  p.style.strokeWidth = "1";
  p.style.pointerEvents = "auto";

  p.addEventListener("mouseenter", () => {
    if (!lockedId || lockedId === polyId) showDetails(polyId, rec, lockedId === polyId);
  });
  p.addEventListener("mouseleave", () => { if (!lockedId) clearDetails(); });

  // Click-to-lock with a little movement slop
  let downX = 0, downY = 0, downPid = null;
  const CLICK_SLOP = 6;

  p.addEventListener("pointerdown", (ev) => {
    downX = ev.clientX; downY = ev.clientY;
    downPid = ev.pointerId;
    try { p.setPointerCapture(downPid); } catch {}
  });

  p.addEventListener("pointerup", (ev) => {
    const moved = Math.hypot(ev.clientX - downX, ev.clientY - downY) > CLICK_SLOP;
    if (downPid !== null) { try { p.releasePointerCapture(downPid); } catch {} downPid = null; }
    if (moved) return;

    if (lockedId === polyId) {
      lockedId = "";
      clearDetails();
      setActivePolygon(null);
    } else {
      lockedId = polyId;
      showDetails(polyId, rec, true);
      setActivePolygon(polyId);
    }
  });

  getPolysLayer().appendChild(p);
}

function setActivePolygon(id) {
  getPolysLayer().querySelectorAll("polygon")
    .forEach(el => el.classList.toggle("active", id && el.id === id));
}

function showDetails(standId, rec, locked = false) {
  const label = rec?.id || standId || "(unknown)";
  const statusKeyed = rec?.status || "unknown";
  const statusTxt = rec?.rawStatus || statusKeyed;

  details.classList.remove("muted");
  details.innerHTML = `
    <div class="detail-row"><div class="detail-label">Stand:</div><div><b>${label}</b></div></div>
    <div class="detail-row"><div class="detail-label">Status:</div>
      <div><span class="pill" style="background:${colorForStatus(statusKeyed)}22;border-color:${colorForStatus(statusKeyed)}55">
        ${statusTxt}
      </span></div>
    </div>
    ${
      rec
        ? Object.entries(rec.row)
            // Hide ID, Status, and LastUpdated from the details panel
            .filter(([h]) =>
              norm(h)!==norm(ID_COLUMN) &&
              norm(h)!==norm(STATUS_COLUMN) &&
              norm(h)!==norm(UPDATED_COLUMN)
            )
            .map(([h,v]) => {
              let val = v || "";
              if (norm(h) === norm(SIZE_COLUMN) && val) val = `${val} m²`;
              return `<div class="detail-row"><div class="detail-label">${h}:</div><div>${val}</div></div>`;
            }).join("")
        : `<div class="muted">No extra data in sheet for this stand.</div>`
    }
    ${locked ? `<div class="muted" style="margin-top:8px">Locked. Click the stand again to unlock or press esc.</div>` : "" }
  `;
}

function clearDetails() {
  if (lockedId) return;
  details.classList.add("muted");
  details.textContent = "Hover over a stand on the map to see its details here.";
}

/* ===========================
   PAN & ZOOM
   =========================== */
function setupPanZoom() {
  const vp = svg.querySelector('#viewport');
  if (!vp) return;

  let scale = 1, minScale = 0.7, maxScale = 4;
  let tx = 0, ty = 0;
  let isPanning = false;
  let lastX = 0, lastY = 0;

  const zoomInBtn = document.getElementById('zoomIn');
  const zoomOutBtn = document.getElementById('zoomOut');
  const zoomResetBtn = document.getElementById('zoomReset');

  function applyTransform() {
    vp.setAttribute('transform', `translate(${tx} ${ty}) scale(${scale})`);
    svg.classList.toggle('can-pan', scale > 1.001);
  }

  function zoomAt(clientX, clientY, delta) {
    const rect = svg.getBoundingClientRect();
    const cx = clientX ?? (rect.left + rect.width/2);
    const cy = clientY ?? (rect.top + rect.height/2);
    const factor = Math.exp(delta);

    const newScale = Math.min(maxScale, Math.max(minScale, scale * factor));
    if (newScale === scale) return;

    tx = cx - (cx - tx) * (newScale/scale);
    ty = cy - (cy - ty) * (newScale/scale);

    scale = newScale;
    applyTransform();
  }

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = -e.deltaY * 0.0015;
    zoomAt(e.clientX, e.clientY, delta);
  }, { passive:false });

  svg.addEventListener('pointerdown', (e) => {
    if (e.target.closest && e.target.closest('#polys-layer polygon')) return;
    if (e.button !== 0) return;
    isPanning = true;
    svg.setPointerCapture(e.pointerId);
    svg.classList.add('grabbing');
    lastX = e.clientX; lastY = e.clientY;
  });
  svg.addEventListener('pointermove', (e) => {
    if (!isPanning) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    tx += dx;
    ty += dy;
    applyTransform();
  });
  svg.addEventListener('pointerup', () => {
    isPanning = false;
    svg.classList.remove('grabbing');
  });
  svg.addEventListener('pointercancel', () => {
    isPanning = false;
    svg.classList.remove('grabbing');
  });

  zoomInBtn?.addEventListener('click', () => zoomAt(undefined, undefined, +0.25));
  zoomOutBtn?.addEventListener('click', () => zoomAt(undefined, undefined, -0.25));
  zoomResetBtn?.addEventListener('click', () => { scale = 1; tx = 0; ty = 0; applyTransform(); });

  applyTransform();
}

/* ===========================
   INIT
   =========================== */
async function init(){
  fitSvgToArtwork();

  const [{ statusMap, lastUpdated }, polysRaw] = await Promise.all([loadSheet(), loadPolygons()]);
  const polys = remapPolygonsToArtwork(polysRaw);

  const layer = getPolysLayer();
  layer.innerHTML = "";
  polys.forEach(p => makePolygon(p, statusMap));

  // Bottom line only (sheet-wide timestamp)
  //const footerEl = document.getElementById("lastUpdated");
  //if (footerEl) {
    //footerEl.textContent = lastUpdated
    //  ? `Last updated ${formatSAST(lastUpdated)}`
   //   : "Last updated …";
 // }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && lockedId) {
    lockedId = "";
    clearDetails();
    setActivePolygon(null);
  }
});

document.addEventListener('DOMContentLoaded', () => {
  init();
  setupPanZoom();
});
