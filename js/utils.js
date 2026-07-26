/**
 * ============================================================================
 * 공용 유틸 — index.html / desktop.html / disneyland.html이 함께 쓰는
 * 순수 함수만 모아둔다. 페이지별 상태/렌더 로직은 각자의 app.js / disney.js에.
 * ============================================================================
 */
function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}
