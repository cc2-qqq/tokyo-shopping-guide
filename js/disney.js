/**
 * ============================================================================
 * Tokyo Disneyland Interactive Map — 렌더링/상태/이벤트
 * ============================================================================
 * DISNEY_DATA(js/disneyData.js)를 유일한 데이터 소스로 사용한다.
 * 길찾기는 파크 내부 보행로 데이터가 없어 직선거리 기준 추정치이며,
 * 화면에 항상 "실제 동선과 다를 수 있음"을 함께 표시한다.
 *
 * 화장실/베이비/충전/휴식/응급시설은 공식적으로 검증 가능한 좌표 출처가
 * 없어 DISNEY_DATA에 아직 데이터가 없다 — 이 카테고리들은 UI(칩, 화장실
 * 찾기 버튼)는 갖춰두되, 실제로는 항상 "확인 필요" 상태로 우아하게
 * 처리한다(추측 좌표를 만들어 넣지 않는다).
 * ============================================================================
 */
(function () {
  "use strict";

  const STORAGE_KEYS = {
    favorites: "tokyoGuide.disney.favorites.v1",
    completed: "tokyoGuide.disney.completed.v1",
    memos: "tokyoGuide.disney.memos.v1",
  };

  const CATEGORY_ICON = { attraction: "🎢", restaurant: "🍽️", shop: "🛍️", restroom: "🚻" };
  const CATEGORY_LABEL = { attraction: "어트랙션", restaurant: "레스토랑", shop: "샵", restroom: "화장실" };
  const WALK_SPEED_MPS = 1.2; // 파크 혼잡도를 감안해 평균 보행속도보다 여유 있게 잡음

  // 지도/목록 필터에 노출하는 전체 카테고리 목록. AVAILABLE에 없는 카테고리는
  // 칩은 보이되 항상 "준비 중" 상태로 취급한다(추측 데이터 금지).
  const CATEGORIES = [
    { id: "all", icon: "🗺️", label: "전체" },
    { id: "attraction", icon: "🎢", label: "어트랙션" },
    { id: "restroom", icon: "🚻", label: "화장실" },
    { id: "restaurant", icon: "🍴", label: "음식" },
    { id: "shop", icon: "🛍", label: "숍" },
    { id: "baby", icon: "👶", label: "베이비" },
    { id: "charging", icon: "🔋", label: "충전" },
    { id: "rest", icon: "🪑", label: "휴식" },
    { id: "emergency", icon: "➕", label: "응급시설" },
  ];
  const AVAILABLE_CATEGORIES = ["attraction", "restaurant", "shop"];
  const SORT_LABEL = { distance: "거리순", area: "구역별", name: "가나다순", rating: "평점순" };
  const COMPASS_KO = ["북", "북동", "동", "남동", "남", "남서", "서", "북서"];

  const state = {
    map: null,
    clusterGroup: null,
    categoryMarkers: {},
    favoriteMarkersLayer: null,
    destinationMarker: null,
    userMarkerLayer: null,
    favorites: {},
    completed: {},
    memos: {},
    userLocation: null,
    watchId: null,
    headingSupported: false,
    activeCategory: null,
    activeTab: "list",
    sheetSort: "distance",
    sheetState: "collapsed", // collapsed | half | expanded
    routeTargetId: null,
    routeLine: null,
    navigationMode: false,
    showRestroomsAlongRoute: false,
    pickLocationMode: false,
  };

  const dom = {};
  let toastTimer = null;

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    cacheDom();
    loadStorage();
    initMap();
    renderCategoryBar();
    renderCategoryMarkers();
    renderFavoriteMarkers();
    renderSheetTabs();
    renderSheetContent();
    applySheetState("collapsed", { silent: true });
    bindEvents();
  }

  function cacheDom() {
    dom.searchInput = document.getElementById("disneySearchInput");
    dom.searchResults = document.getElementById("disneySearchResults");
    dom.categoryBar = document.getElementById("disneyCategoryBar");
    dom.mapWrap = document.querySelector(".disney-map-wrap");
    dom.restroomFab = document.getElementById("disneyRestroomFab");
    dom.locationFallback = document.getElementById("disneyLocationFallback");
    dom.sheet = document.getElementById("disneySheet");
    dom.sheetHandle = document.getElementById("disneySheetHandle");
    dom.sheetTabs = document.getElementById("disneySheetTabs");
    dom.sheetContent = document.getElementById("disneySheetContent");
    dom.detailOverlay = document.getElementById("disneyDetailOverlay");
    dom.detailSheet = document.getElementById("disneyDetailSheet");
    dom.restroomOverlay = document.getElementById("disneyRestroomOverlay");
    dom.restroomSheet = document.getElementById("disneyRestroomSheet");
    dom.locateBtn = document.getElementById("disneyLocateBtn");
    dom.toast = document.getElementById("toast");
  }

  // ---------------------------------------------------------------------
  // LocalStorage
  // ---------------------------------------------------------------------
  function loadStorage() {
    state.favorites = safeParse(localStorage.getItem(STORAGE_KEYS.favorites)) || {};
    state.completed = safeParse(localStorage.getItem(STORAGE_KEYS.completed)) || {};
    state.memos = safeParse(localStorage.getItem(STORAGE_KEYS.memos)) || {};
  }
  function safeParse(json) {
    try {
      return JSON.parse(json);
    } catch (e) {
      return null;
    }
  }
  function persistFavorites() {
    localStorage.setItem(STORAGE_KEYS.favorites, JSON.stringify(state.favorites));
  }
  function persistCompleted() {
    localStorage.setItem(STORAGE_KEYS.completed, JSON.stringify(state.completed));
  }
  function persistMemos() {
    localStorage.setItem(STORAGE_KEYS.memos, JSON.stringify(state.memos));
  }

  function getFacilities() {
    return DISNEY_DATA.disneyland.facilities;
  }
  function findFacility(id) {
    return getFacilities().find((f) => f.id === id) || null;
  }
  function getOrigin() {
    return state.userLocation || DISNEY_DATA.disneyland.coords;
  }

  // 현재 활성 카테고리 기준으로 걸러진 시설 목록 — 지도 마커와 목록 탭이 공유한다.
  // 카테고리를 아무것도 선택하지 않은 기본 화면에서는 아무 것도 반환하지
  // 않는다(현재 위치/즐겨찾기/목적지만 보이는 게 이번 개편의 핵심 목표).
  function getCategoryFilteredFacilities() {
    const cat = state.activeCategory;
    if (!cat) return [];
    if (cat === "all") return getFacilities();
    if (AVAILABLE_CATEGORIES.indexOf(cat) !== -1) return getFacilities().filter((f) => f.category === cat);
    return []; // 아직 데이터가 없는 카테고리(화장실/베이비/충전/휴식/응급시설)
  }

  // ---------------------------------------------------------------------
  // Map
  // ---------------------------------------------------------------------
  function initMap() {
    state.map = L.map("disneyMap", { zoomControl: false, attributionControl: true }).setView(
      DISNEY_DATA.disneyland.coords,
      16
    );
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
      maxZoom: 19,
      subdomains: "abcd",
    }).addTo(state.map);
    L.control.zoom({ position: "bottomright" }).addTo(state.map);

    state.clusterGroup = L.markerClusterGroup({ maxClusterRadius: 55, spiderfyOnMaxZoom: true, showCoverageOnHover: false });
    state.map.addLayer(state.clusterGroup);
    state.favoriteMarkersLayer = L.layerGroup().addTo(state.map);
    state.userMarkerLayer = L.layerGroup().addTo(state.map);

    state.map.on("click", (e) => {
      if (!state.pickLocationMode) return;
      state.pickLocationMode = false;
      state.userLocation = [e.latlng.lat, e.latlng.lng];
      renderUserLocationMarker(state.userLocation, null);
      showToast("현재 위치가 지정됐어요");
      if (state.routeTargetId) drawRoute();
      else refreshDistanceDependentUI();
    });
  }

  function buildFacilityMarker(facility, opts) {
    opts = opts || {};
    const isDone = !!state.completed[facility.id];
    const isFav = !!state.favorites[facility.id];
    const size = opts.large ? 46 : 30;
    const icon = L.divIcon({
      className: "",
      html:
        '<div class="disney-marker ' +
        facility.category +
        (isDone ? " done" : "") +
        (opts.large ? " large" : "") +
        (opts.favorite && isFav ? " favorite" : "") +
        '"><span>' +
        CATEGORY_ICON[facility.category] +
        "</span></div>",
      iconSize: [size, size],
      iconAnchor: [size / 2, size],
    });
    const marker = L.marker(facility.coords, { icon: icon });
    marker.on("click", () => openDetail(facility.id));
    return marker;
  }

  // 카테고리로 걸러진(즐겨찾기 제외 — 중복 표시 방지) 시설만 클러스터에 올린다.
  function renderCategoryMarkers() {
    state.clusterGroup.clearLayers();
    state.categoryMarkers = {};
    const facilities = getCategoryFilteredFacilities().filter((f) => !state.favorites[f.id]);
    facilities.forEach((f) => {
      const marker = buildFacilityMarker(f);
      state.clusterGroup.addLayer(marker);
      state.categoryMarkers[f.id] = marker;
    });
  }

  // 즐겨찾기는 카테고리 선택과 무관하게 항상 지도에 표시(클러스터에 안 묶임)
  function renderFavoriteMarkers() {
    state.favoriteMarkersLayer.clearLayers();
    Object.keys(state.favorites)
      .filter((id) => state.favorites[id])
      .forEach((id) => {
        const f = findFacility(id);
        if (!f) return;
        buildFacilityMarker(f, { favorite: true }).addTo(state.favoriteMarkersLayer);
      });
  }

  function renderDestinationMarker() {
    if (state.destinationMarker) {
      state.map.removeLayer(state.destinationMarker);
      state.destinationMarker = null;
    }
    if (!state.routeTargetId) return;
    const f = findFacility(state.routeTargetId);
    if (!f) return;
    state.destinationMarker = buildFacilityMarker(f, { large: true }).addTo(state.map);
  }

  function focusFacility(id) {
    const facility = findFacility(id);
    if (!facility) return;
    state.map.setView(facility.coords, 18, { animate: true });
  }

  // ---------------------------------------------------------------------
  // 카테고리 필터 칩
  // ---------------------------------------------------------------------
  function renderCategoryBar() {
    dom.categoryBar.innerHTML = CATEGORIES.map((c) => {
      const isActive = state.activeCategory === c.id;
      const unavailable = c.id !== "all" && AVAILABLE_CATEGORIES.indexOf(c.id) === -1;
      return (
        '<button type="button" class="disney-chip' +
        (isActive ? " active" : "") +
        (unavailable ? " unavailable" : "") +
        '" data-category="' +
        c.id +
        '">' +
        c.icon +
        " " +
        c.label +
        "</button>"
      );
    }).join("");
  }

  function selectCategory(catId) {
    state.activeCategory = state.activeCategory === catId ? null : catId;
    renderCategoryBar();
    renderCategoryMarkers();
    if (state.activeCategory && AVAILABLE_CATEGORIES.indexOf(state.activeCategory) === -1 && state.activeCategory !== "all") {
      showToast("아직 준비 중인 카테고리예요 · 디즈니 공식 앱에서 확인해주세요");
    }
    if (state.activeTab === "list") renderListTab();
  }

  // ---------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------
  function handleSearchInput() {
    const q = dom.searchInput.value.trim().toLowerCase();
    if (!q) {
      dom.searchResults.hidden = true;
      dom.searchResults.innerHTML = "";
      return;
    }
    const matches = getFacilities().filter(
      (f) => f.name.toLowerCase().includes(q) || (f.japaneseName || "").toLowerCase().includes(q)
    );
    dom.searchResults.hidden = false;
    dom.searchResults.innerHTML = matches.length
      ? matches.map((f) => buildRowHtml(f, "result")).join("")
      : '<p class="disney-empty-note">검색 결과가 없어요</p>';
  }

  function buildRowHtml(f, kind) {
    const isFav = !!state.favorites[f.id];
    const isDone = !!state.completed[f.id];
    const rowClass = kind === "result" ? "disney-result-row" : "disney-list-row" + (isDone ? " done" : "");
    const dist = haversineMeters(getOrigin(), f.coords);
    return (
      '<div class="' +
      rowClass +
      '" data-facility-id="' +
      f.id +
      '">' +
      '<span class="disney-row-icon ' +
      f.category +
      '">' +
      CATEGORY_ICON[f.category] +
      "</span>" +
      '<span class="disney-row-body"><span class="disney-row-name">' +
      escapeHtml(f.name) +
      "</span>" +
      '<span class="disney-row-meta">' +
      escapeHtml(f.area) +
      " · " +
      formatDistance(dist) +
      " · " +
      formatWalkTime(dist) +
      "</span></span>" +
      '<div class="disney-row-actions">' +
      '<button type="button" class="disney-row-fav' +
      (isFav ? " active" : "") +
      '" data-action="toggle-fav" data-facility-id="' +
      f.id +
      '" aria-label="즐겨찾기">' +
      (isFav ? "♥" : "♡") +
      "</button>" +
      '<button type="button" class="disney-row-route" data-action="route-to" data-facility-id="' +
      f.id +
      '" aria-label="길찾기">🧭</button>' +
      "</div>" +
      "</div>"
    );
  }

  // ---------------------------------------------------------------------
  // Bottom sheet — 목록 / 즐겨찾기 / 추천 동선
  // ---------------------------------------------------------------------
  function renderSheetTabs() {
    const tabs = [
      { id: "list", label: "목록" },
      { id: "favorites", label: "즐겨찾기" },
      { id: "route", label: "추천 동선" },
    ];
    dom.sheetTabs.innerHTML = tabs
      .map(
        (t) =>
          '<button type="button" class="disney-sheet-tab' +
          (state.activeTab === t.id ? " active" : "") +
          '" data-tab="' +
          t.id +
          '">' +
          t.label +
          "</button>"
      )
      .join("");
  }

  function renderSheetContent() {
    if (state.navigationMode) return; // Navigation Mode 중엔 renderNavCard가 sheetContent를 관리
    if (state.activeTab === "list") return renderListTab();
    if (state.activeTab === "favorites") return renderFavoritesTab();
    return renderRouteTab();
  }

  function renderListTab() {
    if (!state.activeCategory) {
      dom.sheetContent.innerHTML = '<p class="disney-empty-note">위 카테고리에서 하나를 선택하면<br>목록이 표시돼요</p>';
      return;
    }
    const facilities = getCategoryFilteredFacilities();
    if (facilities.length === 0) {
      dom.sheetContent.innerHTML = '<p class="disney-empty-note">이 카테고리는 아직 준비 중이에요<br>디즈니 공식 앱에서 확인해주세요</p>';
      return;
    }
    const sortRow =
      '<div class="disney-sheet-sort-row">' +
      ["distance", "area", "name", "rating"]
        .map(
          (s) =>
            '<button type="button" class="disney-sheet-sort-btn' +
            (state.sheetSort === s ? " active" : "") +
            '" data-sort="' +
            s +
            '">' +
            SORT_LABEL[s] +
            "</button>"
        )
        .join("") +
      "</div>";
    const items = facilities.slice().sort(sorterFor(state.sheetSort));
    dom.sheetContent.innerHTML = sortRow + items.map((f) => buildRowHtml(f, "list")).join("");
  }

  function sorterFor(sort) {
    if (sort === "distance") {
      const origin = getOrigin();
      return (a, b) => haversineMeters(origin, a.coords) - haversineMeters(origin, b.coords);
    }
    if (sort === "name") return (a, b) => a.name.localeCompare(b.name, "ko");
    if (sort === "rating") return (a, b) => (b.rating || 0) - (a.rating || 0);
    return (a, b) => a.area.localeCompare(b.area, "ko") || a.name.localeCompare(b.name, "ko");
  }

  function renderFavoritesTab() {
    const favIds = Object.keys(state.favorites).filter((id) => state.favorites[id]);
    const items = getFacilities().filter((f) => favIds.indexOf(f.id) !== -1);
    dom.sheetContent.innerHTML = items.length
      ? items.map((f) => buildRowHtml(f, "list")).join("")
      : '<p class="disney-empty-note">하트를 눌러 즐겨찾기에 담아보세요 ♥</p>';
  }

  function renderRouteTab() {
    const favIds = Object.keys(state.favorites).filter((id) => state.favorites[id] && !state.completed[id]);
    const items = getFacilities().filter((f) => favIds.indexOf(f.id) !== -1);
    if (items.length === 0) {
      dom.sheetContent.innerHTML =
        '<p class="disney-empty-note">즐겨찾기에 담은 곳 중 아직 완료하지 않은 곳이 있으면<br>효율적인 동선을 추천해드려요</p>';
      return;
    }
    const order = computeNearestNeighborRoute(items);
    dom.sheetContent.innerHTML =
      '<p class="disney-empty-note" style="padding:14px 14px 4px;text-align:left;">즐겨찾기 기준 예상 동선(직선거리 추정, 실제와 다를 수 있어요)</p>' +
      order
        .map(
          (item, idx) =>
            '<div class="disney-list-row" data-facility-id="' +
            item.facility.id +
            '">' +
            '<span class="disney-row-icon ' +
            item.facility.category +
            '">' +
            (idx + 1) +
            "</span>" +
            '<span class="disney-row-body"><span class="disney-row-name">' +
            escapeHtml(item.facility.name) +
            "</span>" +
            '<span class="disney-row-meta">' +
            formatDistance(item.distance) +
            " · " +
            formatWalkTime(item.distance) +
            "</span></span>" +
            "</div>"
        )
        .join("");
  }

  // 가장 가까운 미방문 지점을 계속 골라 잇는 최근접 이웃 휴리스틱 —
  // 실제 최단 경로 보장은 아니고 직선거리 기준의 "합리적인 순서" 추정치
  function computeNearestNeighborRoute(items) {
    const start = getOrigin();
    const remaining = items.slice();
    const order = [];
    let current = start;
    while (remaining.length > 0) {
      let bestIdx = 0;
      let bestDist = Infinity;
      remaining.forEach((f, idx) => {
        const d = haversineMeters(current, f.coords);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = idx;
        }
      });
      const next = remaining.splice(bestIdx, 1)[0];
      order.push({ facility: next, distance: bestDist });
      current = next.coords;
    }
    return order;
  }

  function formatDistance(meters) {
    return meters < 1000 ? Math.round(meters) + "m" : (meters / 1000).toFixed(1) + "km";
  }
  function formatWalkTime(meters) {
    const minutes = Math.max(1, Math.round(meters / WALK_SPEED_MPS / 60));
    return "도보 약 " + minutes + "분";
  }

  function refreshDistanceDependentUI() {
    if (state.activeTab === "list" && !state.navigationMode) renderListTab();
  }

  // ---------------------------------------------------------------------
  // 시설 상세 바텀시트
  // ---------------------------------------------------------------------
  function openDetail(id) {
    const f = findFacility(id);
    if (!f) return;
    focusFacility(id);
    const isFav = !!state.favorites[id];
    const isDone = !!state.completed[id];
    const memoText = state.memos[id] || "";
    const dist = haversineMeters(getOrigin(), f.coords);

    dom.detailSheet.innerHTML =
      '<div class="disney-detail-header">' +
      '<div class="disney-detail-icon ' +
      f.category +
      '">' +
      CATEGORY_ICON[f.category] +
      "</div>" +
      '<div class="disney-detail-title-group"><p class="disney-detail-name">' +
      escapeHtml(f.name) +
      (isDone ? '<span class="disney-done-badge">완료</span>' : "") +
      "</p>" +
      '<p class="disney-detail-area">' +
      escapeHtml(f.area) +
      " · " +
      CATEGORY_LABEL[f.category] +
      "</p></div>" +
      '<button type="button" class="disney-detail-fav' +
      (isFav ? " active" : "") +
      '" data-action="toggle-fav" data-facility-id="' +
      f.id +
      '" aria-label="즐겨찾기">' +
      (isFav ? "♥" : "♡") +
      "</button>" +
      "</div>" +
      (f.description ? '<p class="disney-detail-desc">' + escapeHtml(f.description) + "</p>" : "") +
      '<div class="disney-detail-meta-row">' +
      '<span class="disney-detail-chip">📍 ' +
      formatDistance(dist) +
      " · " +
      formatWalkTime(dist) +
      "</span>" +
      (f.recommendedTime ? '<span class="disney-detail-chip">⏱ ' + escapeHtml(f.recommendedTime) + "</span>" : "") +
      (f.priceRange ? '<span class="disney-detail-chip">💴 ' + escapeHtml(f.priceRange) + "</span>" : "") +
      (f.rating ? '<span class="disney-detail-chip">' + "★".repeat(f.rating) + "</span>" : "") +
      "</div>" +
      (f.highlights && f.highlights.length
        ? '<div class="disney-detail-highlights">' +
          f.highlights.map((h) => '<span class="disney-detail-highlight">✓ ' + escapeHtml(h) + "</span>").join("") +
          "</div>"
        : "") +
      '<div class="disney-detail-actions">' +
      '<button type="button" class="btn btn-primary" data-action="route-to" data-facility-id="' +
      f.id +
      '">🧭 길찾기</button>' +
      '<a class="btn btn-outline" href="https://www.google.com/maps/search/?api=1&query=' +
      encodeURIComponent(f.googleMapsQuery || f.name) +
      '" target="_blank" rel="noopener">📍 Google Maps</a>' +
      '<button type="button" class="btn btn-success' +
      (isDone ? " is-checked" : "") +
      '" data-action="toggle-done" data-facility-id="' +
      f.id +
      '">' +
      (isDone ? "✓ 완료됨" : "체크 완료") +
      "</button>" +
      "</div>" +
      '<div class="disney-detail-memo"><span class="disney-section-label">📝 메모</span>' +
      '<textarea data-facility-id="' +
      f.id +
      '" placeholder="예: 8/10 야간개장 때 타기">' +
      escapeHtml(memoText) +
      "</textarea></div>";

    const textarea = dom.detailSheet.querySelector("textarea");
    textarea.addEventListener("change", () => {
      const val = textarea.value;
      if (val.trim()) state.memos[f.id] = val;
      else delete state.memos[f.id];
      persistMemos();
    });

    dom.detailOverlay.classList.add("show");
  }

  function closeDetail() {
    dom.detailOverlay.classList.remove("show");
  }

  // ---------------------------------------------------------------------
  // 즐겨찾기 / 완료 체크
  // ---------------------------------------------------------------------
  function toggleFavorite(id) {
    state.favorites[id] = !state.favorites[id];
    persistFavorites();
    renderCategoryMarkers();
    renderFavoriteMarkers();
    refreshAfterStateChange();
  }
  function toggleCompleted(id) {
    state.completed[id] = !state.completed[id];
    persistCompleted();
    renderCategoryMarkers();
    renderFavoriteMarkers();
    refreshAfterStateChange();
  }
  function refreshAfterStateChange() {
    renderSheetContent();
    if (dom.detailOverlay.classList.contains("show")) {
      const openRow = dom.detailSheet.querySelector("[data-facility-id]");
      if (openRow) openDetail(openRow.dataset.facilityId);
    }
  }

  // ---------------------------------------------------------------------
  // 길찾기 / Navigation Mode
  // 파크 내부 보행로 데이터가 없어 직선거리 기준 추정치이며, 실제 동선과
  // 다를 수 있음을 항상 함께 표시한다.
  // ---------------------------------------------------------------------
  function routeTo(id) {
    const f = findFacility(id);
    if (!f) return;
    state.routeTargetId = id;
    closeDetail();
    closeRestroomFinder();
    enterNavigationMode();
    drawRoute();
  }

  function enterNavigationMode() {
    if (state.navigationMode) return;
    state.navigationMode = true;
    state.map.removeLayer(state.clusterGroup);
    state.map.removeLayer(state.favoriteMarkersLayer);
    dom.sheetTabs.innerHTML = "";
    applySheetState("collapsed");
  }

  function exitNavigationMode() {
    state.navigationMode = false;
    state.map.addLayer(state.clusterGroup);
    state.map.addLayer(state.favoriteMarkersLayer);
    renderSheetTabs();
    renderSheetContent();
  }

  function drawRoute() {
    const f = findFacility(state.routeTargetId);
    if (!f) return;
    const origin = getOrigin();

    if (state.routeLine) state.map.removeLayer(state.routeLine);
    state.routeLine = L.polyline([origin, f.coords], {
      color: "#007AFF",
      weight: 6,
      opacity: 0.9,
      lineCap: "round",
    }).addTo(state.map);
    renderDestinationMarker();
    state.map.fitBounds([origin, f.coords], { padding: [70, 70] });

    renderNavCard();
  }

  function renderNavCard() {
    const f = findFacility(state.routeTargetId);
    if (!f) return;
    const origin = getOrigin();
    const distance = haversineMeters(origin, f.coords);
    const directionText = state.userLocation
      ? "현재 위치 기준 " + bearingToCompassKo(computeBearing(origin, f.coords)) + "쪽 방향"
      : "위치를 켜면 방향 안내가 표시돼요";

    dom.sheetContent.innerHTML =
      '<div class="disney-nav-card">' +
      '<p class="disney-nav-title">🧭 ' +
      escapeHtml(f.name) +
      "</p>" +
      '<div class="disney-nav-meta"><strong>' +
      formatWalkTime(distance) +
      "</strong><span>" +
      formatDistance(distance) +
      "</span></div>" +
      '<p class="disney-nav-direction">' +
      directionText +
      " · 직선거리 추정치라 실제 동선과 다를 수 있어요</p>" +
      '<label class="disney-nav-toggle"><input type="checkbox" id="disneyRestroomAlongRouteToggle"' +
      (state.showRestroomsAlongRoute ? " checked" : "") +
      " /> 경로 주변 화장실 표시</label>" +
      '<div class="disney-nav-actions"><button type="button" class="btn btn-outline" id="disneyEndNavBtn">길찾기 종료</button></div>' +
      "</div>";

    document.getElementById("disneyEndNavBtn").addEventListener("click", closeRoute);
    document.getElementById("disneyRestroomAlongRouteToggle").addEventListener("change", (e) => {
      state.showRestroomsAlongRoute = e.target.checked;
      if (state.showRestroomsAlongRoute) {
        const nearby = getFacilities().filter((fac) => fac.category === "restroom");
        showToast(nearby.length ? "경로 주변 화장실을 표시했어요" : "경로 주변에 확인된 화장실 정보가 아직 없어요");
      }
    });
  }

  function closeRoute() {
    state.routeTargetId = null;
    state.showRestroomsAlongRoute = false;
    if (state.routeLine) {
      state.map.removeLayer(state.routeLine);
      state.routeLine = null;
    }
    renderDestinationMarker();
    exitNavigationMode();
  }

  // 두 좌표 사이의 방위각(0=북, 시계방향)을 구해 8방위 한글 표현으로 변환.
  // 실내 보행로를 모르니 "정확한 다음 코너"가 아니라 대략적인 진행 방향만 안내한다.
  function computeBearing(from, to) {
    const lat1 = (from[0] * Math.PI) / 180;
    const lat2 = (to[0] * Math.PI) / 180;
    const dLng = ((to[1] - from[1]) * Math.PI) / 180;
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }
  function bearingToCompassKo(brng) {
    return COMPASS_KO[Math.round(brng / 45) % 8];
  }

  // ---------------------------------------------------------------------
  // 가장 가까운 화장실 (데이터가 없으면 우아하게 "확인 필요" 상태로 안내)
  // ---------------------------------------------------------------------
  function openRestroomFinder() {
    const origin = getOrigin();
    const restrooms = getFacilities().filter((f) => f.category === "restroom");

    if (restrooms.length === 0) {
      dom.restroomSheet.innerHTML =
        '<div class="disney-restroom-empty">' +
        '<p class="disney-detail-name">🚻 화장실 정보 준비 중</p>' +
        '<p class="disney-detail-desc">화장실 위치는 구글맵이나 공식 사이트에서 개별 검증할 수 있는 출처가 없어 이 지도에는 아직 표시하지 않고 있어요. 정확한 위치는 파크 내 안내도나 디즈니 공식 앱에서 확인해주세요.</p>' +
        '<a class="btn btn-primary" href="https://www.tokyodisneyresort.jp/tdl/" target="_blank" rel="noopener">디즈니 공식 사이트 열기</a>' +
        "</div>";
      dom.restroomOverlay.classList.add("show");
      return;
    }

    const nearest = restrooms
      .slice()
      .sort((a, b) => haversineMeters(origin, a.coords) - haversineMeters(origin, b.coords))
      .slice(0, 3);
    dom.restroomSheet.innerHTML =
      '<p class="disney-detail-name">🚻 가까운 화장실</p>' + nearest.map((r) => buildRestroomRowHtml(r, origin)).join("");
    dom.restroomOverlay.classList.add("show");
    routeTo(nearest[0].id);
  }

  function restroomFlag(v) {
    return v === true ? "✅" : v === false ? "❌" : "확인 필요";
  }

  function buildRestroomRowHtml(r, origin) {
    const dist = haversineMeters(origin, r.coords);
    return (
      '<div class="disney-restroom-row">' +
      '<p class="disney-detail-name" style="font-size:15px;">' +
      escapeHtml(r.name) +
      "</p>" +
      '<p class="disney-detail-area">' +
      escapeHtml(r.area) +
      " · " +
      formatDistance(dist) +
      " · " +
      formatWalkTime(dist) +
      "</p>" +
      '<div class="disney-detail-meta-row">' +
      '<span class="disney-detail-chip">다목적 ' +
      restroomFlag(r.multiPurpose) +
      "</span>" +
      '<span class="disney-detail-chip">기저귀교환대 ' +
      restroomFlag(r.diaperChanging) +
      "</span>" +
      '<span class="disney-detail-chip">어린이용 ' +
      restroomFlag(r.kidsFacility) +
      "</span>" +
      '<span class="disney-detail-chip">베이비센터 인접 ' +
      restroomFlag(r.nearBabyCenter) +
      "</span>" +
      "</div>" +
      '<button type="button" class="btn btn-primary" data-action="route-to" data-facility-id="' +
      r.id +
      '" style="margin-top:10px;width:100%;">🧭 길찾기</button>' +
      "</div>"
    );
  }

  function closeRestroomFinder() {
    dom.restroomOverlay.classList.remove("show");
  }

  // ---------------------------------------------------------------------
  // 현재 위치 — 실시간 추적 + 경로 갱신 + 권한 거부 시 대안 제공
  // ---------------------------------------------------------------------
  function toggleGeolocation() {
    if (state.watchId != null) {
      navigator.geolocation.clearWatch(state.watchId);
      state.watchId = null;
      state.userLocation = null;
      state.userMarkerLayer.clearLayers();
      dom.locateBtn.classList.remove("locate-active");
      if (state.routeTargetId) drawRoute();
      refreshDistanceDependentUI();
      return;
    }
    if (!navigator.geolocation) {
      showToast("이 브라우저에서는 위치 확인을 지원하지 않아요");
      showLocationFallback();
      return;
    }
    dom.locateBtn.classList.add("locate-active");
    maybeRequestOrientationPermission();
    let firstFix = true;
    state.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        hideLocationFallback();
        state.userLocation = [pos.coords.latitude, pos.coords.longitude];
        renderUserLocationMarker(state.userLocation, pos.coords.accuracy || 30);
        if (firstFix) {
          state.map.setView(state.userLocation, 17);
          firstFix = false;
        }
        if (state.routeTargetId) drawRoute();
        refreshDistanceDependentUI();
      },
      (err) => {
        dom.locateBtn.classList.remove("locate-active");
        state.watchId = null;
        const messages = {
          1: "위치 권한이 꺼져 있어요.",
          2: "현재 위치를 확인할 수 없어요.",
          3: "위치 확인이 너무 오래 걸려요.",
        };
        showToast(messages[err.code] || "위치 확인에 실패했어요");
        showLocationFallback();
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
    );
  }

  // 위치 권한이 없거나 실패했을 때도 화면이 멈추지 않도록 항상 3가지 대안을 준다.
  function showLocationFallback() {
    dom.locationFallback.hidden = false;
    dom.locationFallback.innerHTML =
      '<p class="disney-fallback-text">현재 위치를 확인할 수 없어요</p>' +
      '<div class="disney-fallback-actions">' +
      '<button type="button" class="btn btn-outline" id="fallbackEntranceBtn">파크 입구에서 시작</button>' +
      '<button type="button" class="btn btn-outline" id="fallbackPickBtn">지도에서 직접 선택</button>' +
      '<button type="button" class="btn btn-primary" id="fallbackRetryBtn">위치 권한 다시 요청</button>' +
      "</div>";
    document.getElementById("fallbackEntranceBtn").addEventListener("click", () => {
      state.userLocation = DISNEY_DATA.disneyland.coords;
      hideLocationFallback();
      showToast("파크 입구(중앙) 기준으로 안내할게요");
      if (state.routeTargetId) drawRoute();
      refreshDistanceDependentUI();
    });
    document.getElementById("fallbackPickBtn").addEventListener("click", () => {
      state.pickLocationMode = true;
      hideLocationFallback();
      showToast("지도를 눌러 현재 위치를 선택해주세요");
    });
    document.getElementById("fallbackRetryBtn").addEventListener("click", () => {
      hideLocationFallback();
      toggleGeolocation();
    });
  }
  function hideLocationFallback() {
    dom.locationFallback.hidden = true;
    dom.locationFallback.innerHTML = "";
  }

  function renderUserLocationMarker(latlng, accuracy) {
    state.userMarkerLayer.clearLayers();
    if (accuracy) {
      L.circle(latlng, { radius: accuracy, color: "#007AFF", weight: 1, fillColor: "#007AFF", fillOpacity: 0.12 }).addTo(
        state.userMarkerLayer
      );
    }
    const headingHtml = state.headingSupported
      ? '<div class="user-location-heading" id="disneyHeadingArrow">▲</div>'
      : "";
    const icon = L.divIcon({
      className: "",
      html:
        '<div class="user-location-wrap"><div class="user-location-pulse"></div><div class="user-location-dot"></div>' +
        headingHtml +
        "</div>",
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
    L.marker(latlng, { icon: icon, interactive: false, zIndexOffset: 500 }).addTo(state.userMarkerLayer);
  }

  // iOS 13+는 사용자 동작(탭) 안에서만 방향 센서 권한을 요청할 수 있어서
  // 위치 버튼을 누르는 시점에 함께 요청한다. 미지원/거부 시 화살표 없이 점만 표시.
  function maybeRequestOrientationPermission() {
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      DeviceOrientationEvent.requestPermission()
        .then((result) => {
          if (result === "granted") {
            state.headingSupported = true;
            window.addEventListener("deviceorientation", handleOrientation);
          }
        })
        .catch(() => {});
    } else if (typeof DeviceOrientationEvent !== "undefined") {
      state.headingSupported = true;
      window.addEventListener("deviceorientation", handleOrientation);
    }
  }

  function handleOrientation(e) {
    const heading = e.webkitCompassHeading != null ? e.webkitCompassHeading : e.alpha;
    if (heading == null) return;
    const arrow = document.getElementById("disneyHeadingArrow");
    if (arrow) arrow.style.transform = "translate(-50%, 0) rotate(" + heading + "deg)";
  }

  // ---------------------------------------------------------------------
  // 드래그 가능한 바텀시트 — collapsed(30%) / half(55%) / expanded(78%)
  // ---------------------------------------------------------------------
  const SHEET_RATIOS = { collapsed: 0.3, half: 0.55, expanded: 0.78 };
  let dragCtx = null;

  function getSheetAvailableHeight() {
    return dom.mapWrap.getBoundingClientRect().height + dom.sheet.getBoundingClientRect().height;
  }

  function applySheetState(newState, opts) {
    opts = opts || {};
    state.sheetState = newState;
    const available = getSheetAvailableHeight();
    const px = Math.round(available * SHEET_RATIOS[newState]);
    if (opts.silent) {
      dom.sheet.classList.add("dragging");
      dom.sheet.style.height = px + "px";
      void dom.sheet.offsetWidth;
      dom.sheet.classList.remove("dragging");
    } else {
      dom.sheet.style.height = px + "px";
    }
  }

  function nearestSheetState(px, available) {
    let best = "collapsed";
    let bestDiff = Infinity;
    Object.keys(SHEET_RATIOS).forEach((key) => {
      const target = available * SHEET_RATIOS[key];
      const diff = Math.abs(target - px);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = key;
      }
    });
    return best;
  }

  function cycleSheetState() {
    const order = ["collapsed", "half", "expanded"];
    const next = order[(order.indexOf(state.sheetState) + 1) % order.length];
    applySheetState(next);
  }

  function bindSheetDrag() {
    dom.sheetHandle.addEventListener("pointerdown", (e) => {
      dragCtx = {
        startY: e.clientY,
        startHeight: dom.sheet.getBoundingClientRect().height,
        moved: false,
        available: getSheetAvailableHeight(),
      };
      dom.sheet.classList.add("dragging");
      dom.sheetHandle.setPointerCapture(e.pointerId);
    });
    dom.sheetHandle.addEventListener("pointermove", (e) => {
      if (!dragCtx) return;
      const deltaY = dragCtx.startY - e.clientY;
      if (Math.abs(deltaY) > 4) dragCtx.moved = true;
      const minPx = dragCtx.available * SHEET_RATIOS.collapsed;
      const maxPx = dragCtx.available * SHEET_RATIOS.expanded;
      const next = Math.min(maxPx, Math.max(minPx, dragCtx.startHeight + deltaY));
      dom.sheet.style.height = next + "px";
    });
    const endDrag = (e) => {
      if (!dragCtx) return;
      dom.sheet.classList.remove("dragging");
      if (!dragCtx.moved) {
        cycleSheetState();
      } else {
        const currentPx = dom.sheet.getBoundingClientRect().height;
        applySheetState(nearestSheetState(currentPx, dragCtx.available));
      }
      dragCtx = null;
    };
    dom.sheetHandle.addEventListener("pointerup", endDrag);
    dom.sheetHandle.addEventListener("pointercancel", endDrag);
  }

  // ---------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------
  function bindEvents() {
    dom.searchInput.addEventListener("input", handleSearchInput);
    bindSheetDrag();

    dom.categoryBar.addEventListener("click", (e) => {
      const chip = e.target.closest("[data-category]");
      if (chip) selectCategory(chip.dataset.category);
    });

    dom.restroomFab.addEventListener("click", openRestroomFinder);

    dom.sheetTabs.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-tab]");
      if (!btn) return;
      state.activeTab = btn.dataset.tab;
      if (state.sheetState === "collapsed") applySheetState("half");
      renderSheetTabs();
      renderSheetContent();
    });

    document.addEventListener("click", (e) => {
      const sortBtn = e.target.closest("[data-sort]");
      if (sortBtn) {
        state.sheetSort = sortBtn.dataset.sort;
        renderListTab();
        return;
      }

      const favBtn = e.target.closest('[data-action="toggle-fav"]');
      if (favBtn) {
        toggleFavorite(favBtn.dataset.facilityId);
        return;
      }

      const doneBtn = e.target.closest('[data-action="toggle-done"]');
      if (doneBtn) {
        toggleCompleted(doneBtn.dataset.facilityId);
        return;
      }

      const routeBtn = e.target.closest('[data-action="route-to"]');
      if (routeBtn) {
        routeTo(routeBtn.dataset.facilityId);
        return;
      }

      if (e.target === dom.locateBtn || e.target.closest("#disneyLocateBtn")) {
        toggleGeolocation();
        return;
      }

      if (e.target === dom.restroomOverlay) {
        closeRestroomFinder();
        return;
      }

      const row = e.target.closest("[data-facility-id]");
      if (row && !e.target.closest("[data-action]")) {
        dom.searchResults.hidden = true;
        dom.searchInput.value = "";
        openDetail(row.dataset.facilityId);
        return;
      }

      if (e.target === dom.detailOverlay) {
        closeDetail();
      }
    });
  }

  function showToast(msg) {
    dom.toast.textContent = msg;
    dom.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => dom.toast.classList.remove("show"), 1800);
  }
})();
