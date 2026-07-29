/**
 * ============================================================================
 * Tokyo Disneyland / Tokyo DisneySea Interactive Map — 렌더링/상태/이벤트
 * ============================================================================
 * DISNEY_DATA(js/disneyData.js)의 tdl/tds 두 네임스페이스를 완전히 분리해서
 * 다룬다 — 마커/bounds/즐겨찾기/완료기록/경로는 파크마다 절대 섞이지 않는다.
 *
 * 길찾기는 파크 내부 보행로 데이터가 없어 직선거리 기준 추정치이며,
 * 화면에 항상 "실제 동선과 다를 수 있음"을 함께 표시한다(OSRM으로 실제
 * 좌표를 질의해봤더니 요청 지점이 110~140m 밖 도로로 스냅되는 것으로
 * 확인되어, 실내 보행망 데이터가 없다는 게 실측으로 확인됨).
 *
 * 화장실 중 일부(TDL)는 공식 가이드맵 기준 랜드 단위 근사치이고, 베이비/
 * 충전/휴식/응급시설/코인락커와 디즈니씨 전체 데이터는 아직 검증된 좌표가
 * 없다 — 이 카테고리들은 UI(칩, 화장실 찾기 버튼)는 갖춰두되, 데이터가
 * 없으면 항상 "확인 필요/준비 중" 상태로 우아하게 처리한다.
 * ============================================================================
 */
(function () {
  "use strict";

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
    { id: "locker", icon: "📦", label: "코인락커" },
  ];
  const SORT_LABEL = { distance: "거리순", area: "구역별", name: "가나다순", rating: "평점순" };
  const COMPASS_KO = ["북", "북동", "동", "남동", "남", "남서", "서", "북서"];

  // 시설 스키마의 "아이 동반" 관련 필드 기본값 — 공식 텍스트로 재검증되기
  // 전까지는 전부 null(확인 필요)이다. 지도 이미지의 아이콘/숫자를 읽어서
  // 임의로 채우지 않는다(잘못된 키 제한은 실제로 탑승 거부·헛걸음으로
  // 이어질 수 있음).
  const FACILITY_DEFAULTS = {
    minimumHeight: null,
    mustBeAccompanied: null,
    strollerParkingNearby: null,
    childFriendly: null,
    verified: true,
    source: "google-maps-verified",
  };

  const state = {
    currentPark: "tdl", // 'tdl' | 'tds' — 두 파크의 모든 상태를 이 값 하나로 완전히 분리한다
    map: null,
    clusterGroup: null,
    categoryMarkers: {},
    favoriteMarkersLayer: null,
    destinationMarker: null,
    userMarkerLayer: null,
    routeRestroomLayer: null,
    parkBoundsCache: {}, // { tdl: L.LatLngBounds, tds: L.LatLngBounds }
    favorites: {},
    completed: {},
    memos: {},
    controlled: {}, // { facilityId: true } — 사용자가 "통제 중"으로 표시한 시설(추천 동선에서 제외)
    kidsProfile: [], // [{ name, heightCm }] — 파크 공통(가족 단위이므로 파크별로 나누지 않음)
    userLocation: null,
    lastGoodAccuracy: null,
    recentFixes: [], // GPS 스무딩용 최근 픽스 큐
    rejectedJumpStreak: 0, // 연속으로 "비정상 이동"이라 거부된 픽스 수(아래 JUMP_REJECT_LIMIT 참고)
    watchId: null,
    watchMode: "idle", // 'idle' | 'navigating' — 배터리 절약을 위해 길찾기 중에만 고빈도로 갱신
    outsideStreak: 0, // 연속으로 파크 밖으로 감지된 횟수(오탐 방지용 디바운스)
    isInsidePark: true,
    headingSupported: false,
    activeCategory: null,
    activeTab: "list",
    sheetSort: "distance",
    sheetState: "collapsed", // collapsed | half | expanded
    routeTargetId: null,
    routeLine: null,
    routeRestroomMarkers: [],
    lastRouteOrigin: null, // 재탐색 판단 기준(이전에 경로를 그렸던 시작 좌표)
    navigationMode: false,
    showRestroomsAlongRoute: false,
    pickLocationMode: false,
    moreMenuOpen: false,
  };

  const dom = {};
  let toastTimer = null;
  let resizeDebounceTimer = null;

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    cacheDom();
    loadSharedStorage();
    loadParkStorage();
    dom.mapPdfLink.href = getParkData().mapPdf;
    initMap();
    renderParkSwitcher();
    renderCategoryBar();
    renderCategoryMarkers();
    renderFavoriteMarkers();
    renderSheetTabs();
    renderSheetContent();
    applySheetState("collapsed", { silent: true });
    bindEvents();
    window.addEventListener("error", () => {}); // 예기치 못한 오류로 화면이 완전히 멈추지 않도록 최소 안전망
    window.addEventListener("unhandledrejection", () => {});
  }

  function cacheDom() {
    dom.searchInput = document.getElementById("disneySearchInput");
    dom.searchResults = document.getElementById("disneySearchResults");
    dom.parkSwitcher = document.getElementById("disneyParkSwitcher");
    dom.categoryBar = document.getElementById("disneyCategoryBar");
    dom.mapWrap = document.querySelector(".disney-map-wrap");
    dom.restroomFab = document.getElementById("disneyRestroomFab");
    dom.locationFallback = document.getElementById("disneyLocationFallback");
    dom.outsideParkBanner = document.getElementById("disneyOutsideParkBanner");
    dom.tileErrorBanner = document.getElementById("disneyTileErrorBanner");
    dom.lowAccuracyBanner = document.getElementById("disneyLowAccuracyBanner");
    dom.sheet = document.getElementById("disneySheet");
    dom.sheetHandle = document.getElementById("disneySheetHandle");
    dom.sheetTabs = document.getElementById("disneySheetTabs");
    dom.sheetContent = document.getElementById("disneySheetContent");
    dom.detailOverlay = document.getElementById("disneyDetailOverlay");
    dom.detailSheet = document.getElementById("disneyDetailSheet");
    dom.restroomOverlay = document.getElementById("disneyRestroomOverlay");
    dom.restroomSheet = document.getElementById("disneyRestroomSheet");
    dom.locateBtn = document.getElementById("disneyLocateBtn");
    dom.moreBtn = document.getElementById("disneyMoreBtn");
    dom.moreMenu = document.getElementById("disneyMoreMenu");
    dom.mapPdfLink = document.getElementById("disneyMapPdfLink");
    dom.kidsProfileBtn = document.getElementById("disneyKidsProfileBtn");
    dom.kidsProfileOverlay = document.getElementById("disneyKidsProfileOverlay");
    dom.kidsProfileSheet = document.getElementById("disneyKidsProfileSheet");
    dom.toast = document.getElementById("toast");
  }

  // ---------------------------------------------------------------------
  // LocalStorage — 즐겨찾기/완료/메모/통제구역은 파크별로 완전히 분리,
  // 아이 키 프로필은 가족 공통이라 파크와 무관하게 하나만 둔다.
  // ---------------------------------------------------------------------
  function parkStorageKey(name) {
    return "tokyoGuide.disney." + state.currentPark + "." + name + ".v1";
  }
  function legacyStorageKey(name) {
    // 파크 구분이 생기기 전(디즈니랜드 단일 파크 시절) 저장했던 키 — tdl로 1회 이관한다
    return "tokyoGuide.disney." + name + ".v1";
  }
  function safeParse(json) {
    try {
      return JSON.parse(json);
    } catch (e) {
      return null;
    }
  }
  function safeGetItem(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null; // 시크릿 모드 등으로 스토리지 접근 자체가 막힌 경우
    }
  }
  function safeSetItem(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      showToast("기기 저장공간에 문제가 있어 임시로만 저장돼요");
    }
  }

  function loadParkStorage() {
    ["favorites", "completed", "memos", "controlled"].forEach((name) => {
      let raw = safeGetItem(parkStorageKey(name));
      if (raw == null && state.currentPark === "tdl") {
        // 이전 세션(파크 구분 없던 시절)의 디즈니랜드 데이터를 한 번만 이관
        const legacy = safeGetItem(legacyStorageKey(name));
        if (legacy != null) {
          raw = legacy;
          safeSetItem(parkStorageKey(name), legacy);
        }
      }
      state[name] = safeParse(raw) || {};
    });
  }
  function loadSharedStorage() {
    state.kidsProfile = safeParse(safeGetItem("tokyoGuide.disney.kidsProfile.v1")) || [];
  }
  function persistFavorites() {
    safeSetItem(parkStorageKey("favorites"), JSON.stringify(state.favorites));
  }
  function persistCompleted() {
    safeSetItem(parkStorageKey("completed"), JSON.stringify(state.completed));
  }
  function persistMemos() {
    safeSetItem(parkStorageKey("memos"), JSON.stringify(state.memos));
  }
  function persistControlled() {
    safeSetItem(parkStorageKey("controlled"), JSON.stringify(state.controlled));
  }
  function persistKidsProfile() {
    safeSetItem("tokyoGuide.disney.kidsProfile.v1", JSON.stringify(state.kidsProfile));
  }

  // ---------------------------------------------------------------------
  // 파크 데이터 접근 — 이 함수들만 거치면 항상 현재 선택된 파크 기준이다
  // ---------------------------------------------------------------------
  function getParkData() {
    return DISNEY_DATA[state.currentPark];
  }
  function getFacilities() {
    return getParkData().facilities.map((f) => Object.assign({}, FACILITY_DEFAULTS, f));
  }
  function findFacility(id) {
    return getFacilities().find((f) => f.id === id) || null;
  }
  function getOrigin() {
    return state.userLocation || getParkData().coords;
  }

  // 현재 활성 카테고리 기준으로 걸러진 시설 목록 — 지도 마커와 목록 탭이 공유한다.
  // 카테고리를 아무것도 선택하지 않은 기본 화면에서는 아무 것도 반환하지
  // 않는다(현재 위치/즐겨찾기/목적지만 보이는 게 이번 개편의 핵심 목표).
  function getCategoryFilteredFacilities() {
    const cat = state.activeCategory;
    const facilities = getFacilities();
    if (!cat) return [];
    if (cat === "all") return facilities;
    const known = ["attraction", "restaurant", "shop", "restroom"];
    if (known.indexOf(cat) !== -1) return facilities.filter((f) => f.category === cat);
    return []; // 아직 데이터가 없는 카테고리(베이비/충전/휴식/응급시설/코인락커)
  }

  function isKnownCategory(catId) {
    return catId === "all" || getFacilities().some((f) => f.category === catId) || catId === "restroom";
  }

  // ---------------------------------------------------------------------
  // 파크 경계(bounds) — 검증된 시설 좌표에서만 계산한다(1순위). 좌표가
  // 없는 파크(TDS)는 파크 중심 주변의 넉넉한 임시 사각형을 쓴다.
  // 이상치(다른 좌표들과 비정상적으로 먼 점 하나 때문에 bounds가 과도하게
  // 넓어지는 것)는 중앙값 기준 거리로 걸러낸다.
  // ---------------------------------------------------------------------
  function computeParkBounds(parkKey) {
    if (state.parkBoundsCache[parkKey]) return state.parkBoundsCache[parkKey];

    const park = DISNEY_DATA[parkKey];
    const points = park.facilities.map((f) => f.coords).concat([park.coords]);

    let usablePoints = points;
    if (points.length >= 4) {
      const lats = points.map((p) => p[0]).sort((a, b) => a - b);
      const lngs = points.map((p) => p[1]).sort((a, b) => a - b);
      const medianLat = lats[Math.floor(lats.length / 2)];
      const medianLng = lngs[Math.floor(lngs.length / 2)];
      // 중앙값에서 haversineMeters로 너무 멀리 떨어진(파크 규모상 비정상적인) 점은 제외
      usablePoints = points.filter((p) => haversineMeters([medianLat, medianLng], p) < 3000);
    }

    let bounds;
    if (usablePoints.length >= 2) {
      bounds = L.latLngBounds(usablePoints).pad(0.08);
    } else {
      // 검증된 좌표가 파크 중심 하나뿐(TDS) — 파크 규모를 감안한 넉넉한 임시 사각형
      const c = park.coords;
      const d = 0.012; // 약 1.3km 반경
      bounds = L.latLngBounds([c[0] - d, c[1] - d], [c[0] + d, c[1] + d]);
    }
    state.parkBoundsCache[parkKey] = bounds;
    return bounds;
  }

  function recomputeMinZoom() {
    if (!state.map) return;
    const bounds = computeParkBounds(state.currentPark);
    try {
      const zoom = state.map.getBoundsZoom(bounds, false);
      state.map.setMinZoom(Math.max(14, zoom - 0.5));
    } catch (e) {
      state.map.setMinZoom(15);
    }
  }

  // ---------------------------------------------------------------------
  // Map
  // ---------------------------------------------------------------------
  function initMap() {
    const bounds = computeParkBounds(state.currentPark);
    state.map = L.map("disneyMap", { zoomControl: false, attributionControl: true, maxBoundsViscosity: 0.9 });
    state.map.fitBounds(bounds, { padding: [12, 12] });
    state.map.setMaxBounds(bounds);
    state.map.setMaxZoom(19);

    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
      maxZoom: 19,
      subdomains: "abcd",
    })
      .on("tileerror", handleTileError)
      .addTo(state.map);

    L.control.zoom({ position: "bottomright" }).addTo(state.map);

    state.clusterGroup = L.markerClusterGroup({ maxClusterRadius: 55, spiderfyOnMaxZoom: true, showCoverageOnHover: false });
    state.map.addLayer(state.clusterGroup);
    state.favoriteMarkersLayer = L.layerGroup().addTo(state.map);
    state.userMarkerLayer = L.layerGroup().addTo(state.map);
    state.routeRestroomLayer = L.layerGroup().addTo(state.map);

    recomputeMinZoom();

    // maxBounds가 대부분 막아주지만, 관성 스크롤 등으로 살짝 벗어난 경우의 안전망.
    // panInsideBounds 자체가 다시 moveend를 동기적으로 발생시킬 수 있어(Leaflet의
    // maxBounds 내부 보정과 겹치면 특히), 재진입 방지 플래그 없이는 스택 오버플로우가
    // 날 수 있다 — 실제로 파크 전환 중 재현되어 이 가드를 추가함.
    let boundsCorrectionInProgress = false;
    state.map.on("moveend", () => {
      if (boundsCorrectionInProgress) return;
      const b = computeParkBounds(state.currentPark);
      if (!b.contains(state.map.getCenter())) {
        boundsCorrectionInProgress = true;
        state.map.panInsideBounds(b, { animate: false });
        boundsCorrectionInProgress = false;
      }
    });

    state.map.on("click", (e) => {
      if (!state.pickLocationMode) return;
      state.pickLocationMode = false;
      state.userLocation = [e.latlng.lat, e.latlng.lng];
      renderUserLocationMarker(state.userLocation, null);
      showToast("현재 위치가 지정됐어요");
      if (state.routeTargetId) drawRoute();
      else refreshDistanceDependentUI();
    });

    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("orientationchange", handleViewportChange);
  }

  let tileErrorShown = false;
  function handleTileError() {
    if (tileErrorShown) return;
    tileErrorShown = true;
    dom.tileErrorBanner.hidden = false;
    dom.tileErrorBanner.textContent = "🗺️ 지도 타일을 불러오지 못했습니다 · 목록과 검색은 계속 사용할 수 있어요";
  }

  function handleViewportChange() {
    clearTimeout(resizeDebounceTimer);
    resizeDebounceTimer = setTimeout(() => {
      if (!state.map) return;
      state.map.invalidateSize();
      recomputeMinZoom();
      const b = computeParkBounds(state.currentPark);
      if (!b.contains(state.map.getCenter())) state.map.panInsideBounds(b, { animate: false });
    }, 200);
  }

  function buildFacilityMarker(facility, opts) {
    opts = opts || {};
    const isDone = !!state.completed[facility.id];
    const isControlled = !!state.controlled[facility.id];
    const isFav = !!state.favorites[facility.id];
    const size = opts.large ? 46 : 30;
    const icon = L.divIcon({
      className: "",
      html:
        '<div class="disney-marker ' +
        facility.category +
        (isDone ? " done" : "") +
        (isControlled ? " controlled" : "") +
        (opts.large ? " large" : "") +
        (opts.favorite && isFav ? " favorite" : "") +
        '"><span>' +
        (isControlled ? "🚧" : CATEGORY_ICON[facility.category]) +
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
  // 파크 전환 — Disneyland / DisneySea. 모든 화면 상태를 완전히 초기화한 뒤
  // 새 파크 데이터/bounds/줌을 다시 적용한다(두 파크 데이터를 섞지 않음).
  // ---------------------------------------------------------------------
  function renderParkSwitcher() {
    const parks = [
      { key: "tdl", label: "🏰 디즈니랜드" },
      { key: "tds", label: "🌊 디즈니씨" },
    ];
    dom.parkSwitcher.innerHTML = parks
      .map(
        (p) =>
          '<button type="button" class="disney-park-tab' +
          (state.currentPark === p.key ? " active" : "") +
          '" data-park="' +
          p.key +
          '">' +
          p.label +
          "</button>"
      )
      .join("");
  }

  function switchPark(parkKey) {
    if (parkKey === state.currentPark || !DISNEY_DATA[parkKey]) return;

    // 1~7: 이전 파크의 화면 상태를 전부 초기화
    closeDetail();
    closeRestroomFinder();
    closeMoreMenu();
    if (state.routeTargetId) closeRoute();
    state.activeCategory = null;
    dom.searchInput.value = "";
    dom.searchResults.hidden = true;
    dom.searchResults.innerHTML = "";
    state.userLocation = null;
    state.recentFixes = [];
    state.outsideStreak = 0;
    state.isInsidePark = true;
    hideOutsideParkBanner();
    if (state.watchId != null) {
      navigator.geolocation.clearWatch(state.watchId);
      state.watchId = null;
      dom.locateBtn.classList.remove("locate-active");
    }
    state.userMarkerLayer.clearLayers();

    // 8: 새 파크 데이터 로드
    state.currentPark = parkKey;
    loadParkStorage();

    // 9~11: 새 bounds/줌/전체보기 적용
    const bounds = computeParkBounds(parkKey);
    state.map.setMaxBounds(bounds);
    state.map.fitBounds(bounds, { padding: [12, 12] });
    recomputeMinZoom();

    dom.mapPdfLink.href = getParkData().mapPdf;

    renderParkSwitcher();
    renderCategoryBar();
    renderCategoryMarkers();
    renderFavoriteMarkers();
    renderSheetTabs();
    renderSheetContent();

    if (getParkData().facilities.length === 0) {
      showToast(getParkData().name + " 데이터는 아직 준비 중이에요 — 실제 좌표 조사가 끝나는 대로 채워질 예정입니다");
    }
  }

  // ---------------------------------------------------------------------
  // 카테고리 필터 칩
  // ---------------------------------------------------------------------
  function renderCategoryBar() {
    dom.categoryBar.innerHTML = CATEGORIES.map((c) => {
      const isActive = state.activeCategory === c.id;
      const unavailable = c.id !== "all" && !getFacilities().some((f) => f.category === c.id);
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
    if (state.activeCategory && state.activeCategory !== "all" && !getFacilities().some((f) => f.category === state.activeCategory)) {
      showToast("아직 준비 중인 카테고리예요 · 디즈니 공식 앱에서 확인해주세요");
    }
    if (state.activeTab === "list") renderListTab();
  }

  // ---------------------------------------------------------------------
  // Search — 한글/영문/일본어 별칭 모두 매칭
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
    const isControlled = !!state.controlled[f.id];
    const rowClass = kind === "result" ? "disney-result-row" : "disney-list-row" + (isDone ? " done" : "");
    const dist = haversineMeters(getOrigin(), f.coords);
    const heightNote = f.minimumHeight != null ? "키 " + f.minimumHeight + "cm~" : "";
    return (
      '<div class="' +
      rowClass +
      '" data-facility-id="' +
      f.id +
      '">' +
      '<span class="disney-row-icon ' +
      f.category +
      '">' +
      (isControlled ? "🚧" : CATEGORY_ICON[f.category]) +
      "</span>" +
      '<span class="disney-row-body"><span class="disney-row-name">' +
      escapeHtml(f.name) +
      (isControlled ? '<span class="disney-controlled-badge">통제중</span>' : "") +
      "</span>" +
      '<span class="disney-row-meta">' +
      escapeHtml(f.area) +
      " · " +
      formatDistance(dist) +
      " · " +
      formatWalkTime(dist) +
      (heightNote ? " · " + heightNote : "") +
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
      const notReadyMsg = getParkData().facilities.length === 0
        ? getParkData().name + " 데이터는 아직 준비 중이에요"
        : "이 카테고리는 아직 준비 중이에요<br>디즈니 공식 앱에서 확인해주세요";
      dom.sheetContent.innerHTML = '<p class="disney-empty-note">' + notReadyMsg + "</p>";
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
    // 통제 중으로 표시한 시설은 추천 동선 계산에서 제외한다
    const favIds = Object.keys(state.favorites).filter(
      (id) => state.favorites[id] && !state.completed[id] && !state.controlled[id]
    );
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
  function kidHeightStatusHtml(f) {
    if (f.minimumHeight == null) {
      return '<span class="disney-detail-chip">키 제한: 확인 필요</span>';
    }
    if (!state.kidsProfile.length) {
      return '<span class="disney-detail-chip">키 제한 ' + f.minimumHeight + "cm~ · 프로필에 아이 키를 등록해보세요</span>";
    }
    return state.kidsProfile
      .map((kid) => {
        const ok = kid.heightCm >= f.minimumHeight;
        return (
          '<span class="disney-detail-chip ' +
          (ok ? "kid-ok" : "kid-no") +
          '">' +
          escapeHtml(kid.name) +
          "(" +
          kid.heightCm +
          "cm) " +
          (ok ? "이용 가능" : "키 제한으로 불가") +
          "</span>"
        );
      })
      .join("");
  }

  function openDetail(id) {
    const f = findFacility(id);
    if (!f) return;
    focusFacility(id);
    const isFav = !!state.favorites[id];
    const isDone = !!state.completed[id];
    const isControlled = !!state.controlled[id];
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
      (f.approximate ? '<span class="disney-approx-badge">근사 위치</span>' : "") +
      (isControlled ? '<span class="disney-controlled-badge">통제중</span>' : "") +
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
      (f.category === "attraction" ? kidHeightStatusHtml(f) : "") +
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
      '<button type="button" class="disney-controlled-toggle' +
      (isControlled ? " active" : "") +
      '" data-action="toggle-controlled" data-facility-id="' +
      f.id +
      '">🚧 ' +
      (isControlled ? "통제 해제하기" : "이 장소 통제 중으로 표시") +
      "</button>" +
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
  // 즐겨찾기 / 완료 체크 / 통제구역
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
  function toggleControlled(id) {
    state.controlled[id] = !state.controlled[id];
    persistControlled();
    showToast(state.controlled[id] ? "이 장소를 통제 중으로 표시했어요 · 추천 동선에서 제외돼요" : "통제 해제했어요");
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
  // 사용자가 명시적으로 "길찾기"를 누른 경우 — 열려 있던 상세/화장실 시트를
  // 닫고 바로 Navigation Mode(안내 카드)로 이동시킨다.
  function routeTo(id) {
    closeDetail();
    closeRestroomFinder();
    startRoute(id);
  }

  // 화장실 찾기에서 "가장 가까운 곳"을 자동으로 미리 보여줄 때 쓴다 —
  // 목록 시트는 그대로 열어둔 채 지도/안내 카드만 뒤에서 갱신한다.
  function startRoute(id) {
    const f = findFacility(id);
    if (!f) return;
    state.routeTargetId = id;
    state.watchMode = "navigating";
    applyWatchFrequency();
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

  // 직선 경로만 그릴 수 있으므로 "경로 이탈"이라는 개념 자체가 없다(경로는
  // 항상 현재 위치에서 새로 그어진다). 대신 마지막으로 그린 지점에서
  // RECALC_THRESHOLD_M 이상 움직였을 때만 "다시 계산 중" 표시와 함께
  // 갱신해서, 사소한 GPS 흔들림마다 화면이 계속 깜빡이지 않게 한다.
  const RECALC_THRESHOLD_M = 30;

  function drawRoute() {
    const f = findFacility(state.routeTargetId);
    if (!f) return;
    const origin = getOrigin();

    const movedFar = state.lastRouteOrigin && haversineMeters(state.lastRouteOrigin, origin) >= RECALC_THRESHOLD_M;
    if (movedFar) showToast("경로를 다시 계산하고 있습니다");
    state.lastRouteOrigin = origin;

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
      toggleRouteRestrooms(state.showRestroomsAlongRoute);
    });
  }

  // 경로에서 크게 벗어나지 않는(출발지 또는 목적지에서 400m 이내) 화장실만 지도에 얹는다.
  function toggleRouteRestrooms(show) {
    state.routeRestroomLayer.clearLayers();
    state.routeRestroomMarkers = [];
    if (!show) return;

    const dest = findFacility(state.routeTargetId);
    if (!dest) return;
    const origin = getOrigin();
    const nearby = getFacilities()
      .filter((f) => f.category === "restroom")
      .filter((r) => Math.min(haversineMeters(origin, r.coords), haversineMeters(dest.coords, r.coords)) <= 400);

    if (nearby.length === 0) {
      showToast("경로 주변(400m 이내)에 확인된 화장실이 없어요");
      return;
    }
    nearby.forEach((r) => {
      buildFacilityMarker(r).addTo(state.routeRestroomLayer);
    });
    showToast(nearby.length + "곳의 화장실을 경로 주변에 표시했어요");
  }

  function closeRoute() {
    state.routeTargetId = null;
    state.showRestroomsAlongRoute = false;
    state.lastRouteOrigin = null;
    state.watchMode = "idle";
    applyWatchFrequency();
    toggleRouteRestrooms(false);
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
    const restrooms = getFacilities().filter((f) => f.category === "restroom" && !state.controlled[f.id]);

    if (restrooms.length === 0) {
      dom.restroomSheet.innerHTML =
        '<div class="disney-restroom-empty">' +
        '<p class="disney-detail-name">🚻 화장실 정보 준비 중</p>' +
        '<p class="disney-detail-desc">' +
        getParkData().name +
        "의 화장실 위치는 구글맵이나 공식 사이트에서 개별 검증할 수 있는 출처가 없어 이 지도에는 아직 표시하지 않고 있어요. 정확한 위치는 파크 내 안내도나 디즈니 공식 앱에서 확인해주세요.</p>" +
        '<a class="btn btn-primary" href="https://www.tokyodisneyresort.jp/' +
        (state.currentPark === "tds" ? "tds" : "tdl") +
        '/" target="_blank" rel="noopener">디즈니 공식 사이트 열기</a>' +
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
    startRoute(nearest[0].id);
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
      (r.approximate ? '<span class="disney-approx-badge">근사 위치</span>' : "") +
      "</p>" +
      '<p class="disney-detail-area">' +
      escapeHtml(r.area) +
      " · " +
      formatDistance(dist) +
      " · " +
      formatWalkTime(dist) +
      "</p>" +
      (r.approximate
        ? '<p class="disney-approx-note">공식 가이드맵 기준 랜드 단위 근사 위치예요 · 개별 화장실 GPS는 아직 검증되지 않았어요</p>'
        : "") +
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
  // 현재 위치 — 실시간 추적 + GPS 안정화 + 파크 밖 판정 + 배터리 절약
  // ---------------------------------------------------------------------
  const LOW_ACCURACY_M = 50;
  const REJECT_ACCURACY_M = 100; // 이보다 정확도가 낮은(오차가 큰) 픽스는 아예 반영하지 않음
  const MAX_JUMP_MPS = 8; // 사람이 걷는 속도를 크게 초과하는 순간 이동은 GPS 튐으로 간주해 무시
  const JUMP_REJECT_LIMIT = 3; // 이 횟수만큼 연속으로 거부되면 실제 이동으로 보고 받아들임(영구 잠금 방지)
  const OUTSIDE_DEBOUNCE_COUNT = 3; // 연속 3회 이상 파크 밖으로 감지될 때만 "밖" 상태로 전환

  function applyWatchFrequency() {
    if (state.watchId == null) return;
    // 브라우저 Geolocation API는 폴링 주기를 직접 지정할 수 없어(구현체마다 다름),
    // maximumAge/enableHighAccuracy 조합으로 사실상의 빈도를 조절한다 —
    // 길찾기 중엔 항상 최신 고정밀 픽스를, 평상시엔 약간 오래된 값도 허용해 배터리를 아낀다.
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = navigator.geolocation.watchPosition(handlePositionUpdate, handlePositionError, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: state.watchMode === "navigating" ? 2000 : 8000,
    });
  }

  function toggleGeolocation() {
    if (state.watchId != null) {
      navigator.geolocation.clearWatch(state.watchId);
      state.watchId = null;
      state.userLocation = null;
      state.recentFixes = [];
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
    state.watchMode = state.navigationMode ? "navigating" : "idle";
    let firstFix = true;
    state.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        handlePositionUpdate(pos);
        if (firstFix && state.userLocation) {
          state.map.setView(state.userLocation, 17);
          firstFix = false;
        }
      },
      handlePositionError,
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
    );

    document.addEventListener("visibilitychange", handleVisibilityChange);
  }

  // 화면이 백그라운드로 가면 위치 갱신을 잠시 멈추고, 돌아오면 다시 켠다(배터리 절약).
  function handleVisibilityChange() {
    if (state.watchId == null) return;
    if (document.hidden) {
      navigator.geolocation.clearWatch(state.watchId);
      state.watchId = null;
    } else {
      applyWatchFrequency();
    }
  }

  function handlePositionError(err) {
    dom.locateBtn.classList.remove("locate-active");
    state.watchId = null;
    const messages = {
      1: "위치 권한이 꺼져 있어요.",
      2: "현재 위치를 확인할 수 없어요.",
      3: "위치 확인이 너무 오래 걸려요.",
    };
    showToast(messages[err.code] || "위치 확인에 실패했어요");
    showLocationFallback();
  }

  function handlePositionUpdate(pos) {
    hideLocationFallback();
    const accuracy = pos.coords.accuracy || 999;
    const fix = [pos.coords.latitude, pos.coords.longitude];

    // 정확도가 지나치게 낮은 픽스는 경로/거리 계산에 아예 반영하지 않는다
    if (accuracy > REJECT_ACCURACY_M) {
      showLowAccuracyBanner(accuracy);
      return;
    }
    // 도보로는 나올 수 없는 순간 이동(직전 픽스 대비)은 GPS 튐으로 보고 무시.
    // 단, 튐이 계속 같은 방향으로 반복되면(예: 택시로 파크를 빠르게 빠져나간 경우,
    // 또는 GPS가 건물/터널에서 벗어나 위치가 실제로 크게 바뀐 경우) 그건 튐이
    // 아니라 실제 이동이므로, 연속 거부 횟수가 임계치를 넘으면 새 위치를 받아들여
    // 이전의 낡은 위치에 영원히 묶이는 것을 막는다.
    if (state.userLocation) {
      const jump = haversineMeters(state.userLocation, fix);
      const seconds = Math.max(1, (pos.timestamp - (state.lastFixTimestamp || pos.timestamp)) / 1000);
      if (jump / seconds > MAX_JUMP_MPS) {
        state.rejectedJumpStreak += 1;
        if (state.rejectedJumpStreak < JUMP_REJECT_LIMIT) return;
        state.recentFixes = []; // 스무딩 큐를 비워 새 위치로 빠르게 수렴시킴
      }
    }
    state.rejectedJumpStreak = 0;
    state.lastFixTimestamp = pos.timestamp;

    if (accuracy > LOW_ACCURACY_M) {
      showLowAccuracyBanner(accuracy);
    } else {
      hideLowAccuracyBanner();
    }

    // 최근 픽스 여러 개를 평균 내어 완만화(단순 이동평균)
    state.recentFixes.push(fix);
    if (state.recentFixes.length > 4) state.recentFixes.shift();
    const avgLat = state.recentFixes.reduce((s, p) => s + p[0], 0) / state.recentFixes.length;
    const avgLng = state.recentFixes.reduce((s, p) => s + p[1], 0) / state.recentFixes.length;
    state.userLocation = [avgLat, avgLng];

    renderUserLocationMarker(state.userLocation, accuracy);
    updateInsideParkStatus(state.userLocation);

    if (state.routeTargetId) drawRoute();
    refreshDistanceDependentUI();
  }

  // 파크 밖으로 잠깐 튀는 오탐을 막기 위해, 연속 N회 이상 밖으로 감지될
  // 때만 실제로 "밖" 상태로 전환한다.
  function updateInsideParkStatus(latlng) {
    const bounds = computeParkBounds(state.currentPark);
    const inside = bounds.contains(latlng);
    if (inside) {
      state.outsideStreak = 0;
      if (!state.isInsidePark) {
        state.isInsidePark = true;
        hideOutsideParkBanner();
      }
      return;
    }
    state.outsideStreak += 1;
    if (state.outsideStreak >= OUTSIDE_DEBOUNCE_COUNT && state.isInsidePark) {
      state.isInsidePark = false;
      showOutsideParkBanner();
    }
  }

  function showOutsideParkBanner() {
    dom.outsideParkBanner.hidden = false;
    dom.outsideParkBanner.innerHTML =
      '<span>현재 파크 외부에 있는 것으로 보여요</span>' +
      '<button type="button" class="btn btn-outline" id="disneyUseEntranceBtn">파크 입구를 출발점으로 사용</button>';
    document.getElementById("disneyUseEntranceBtn").addEventListener("click", () => {
      state.userLocation = getParkData().coords;
      hideOutsideParkBanner();
      if (state.routeTargetId) drawRoute();
      refreshDistanceDependentUI();
    });
    // 지도 중심은 파크 밖 실제 GPS로 옮기지 않고 그대로 파크 전체 보기를 유지한다
  }
  function hideOutsideParkBanner() {
    dom.outsideParkBanner.hidden = true;
    dom.outsideParkBanner.innerHTML = "";
  }

  function showLowAccuracyBanner(accuracy) {
    dom.lowAccuracyBanner.hidden = false;
    dom.lowAccuracyBanner.textContent = "📡 GPS 정확도가 낮습니다 (오차 약 " + Math.round(accuracy) + "m)";
  }
  function hideLowAccuracyBanner() {
    dom.lowAccuracyBanner.hidden = true;
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
      state.userLocation = getParkData().coords;
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
    handleViewportChange(); // 시트 높이가 바뀌면 지도 크기/최소줌/중심도 다시 맞춘다
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
  // Quick Actions 더보기 메뉴
  // ---------------------------------------------------------------------
  function toggleMoreMenu() {
    state.moreMenuOpen = !state.moreMenuOpen;
    dom.moreMenu.hidden = !state.moreMenuOpen;
    if (!state.moreMenuOpen) return;
    dom.moreMenu.innerHTML =
      '<button type="button" data-more-action="fit">🗺️ 파크 전체 보기</button>' +
      '<button type="button" data-more-action="food">🍴 가장 가까운 음식점</button>' +
      '<button type="button" data-more-action="rest">🪑 가장 가까운 휴식 장소</button>' +
      '<button type="button" data-more-action="north">🧭 지도 북쪽 정렬</button>' +
      (state.routeTargetId ? '<button type="button" data-more-action="endroute">⏹️ 경로 종료</button>' : "");
  }
  function closeMoreMenu() {
    state.moreMenuOpen = false;
    dom.moreMenu.hidden = true;
  }

  function handleMoreAction(action) {
    if (action === "fit") {
      state.map.fitBounds(computeParkBounds(state.currentPark), { padding: [12, 12] });
    } else if (action === "food") {
      routeToNearestOfCategory("restaurant");
    } else if (action === "rest") {
      showToast("휴식 장소 데이터는 아직 준비 중이에요");
    } else if (action === "north") {
      state.map.fitBounds(computeParkBounds(state.currentPark), { padding: [12, 12] }); // 지도를 회전시키지 않으므로 사실상 항상 북쪽 기준 — 전체 보기로 복귀
    } else if (action === "endroute") {
      closeRoute();
    }
    closeMoreMenu();
  }

  function routeToNearestOfCategory(category) {
    const origin = getOrigin();
    const candidates = getFacilities().filter((f) => f.category === category && !state.controlled[f.id]);
    if (candidates.length === 0) {
      showToast("조건에 맞는 시설이 없어요");
      return;
    }
    let best = candidates[0];
    let bestDist = haversineMeters(origin, best.coords);
    candidates.forEach((f) => {
      const d = haversineMeters(origin, f.coords);
      if (d < bestDist) {
        bestDist = d;
        best = f;
      }
    });
    routeTo(best.id);
  }

  // ---------------------------------------------------------------------
  // 아이 키 프로필
  // ---------------------------------------------------------------------
  function openKidsProfile() {
    renderKidsProfileSheet();
    dom.kidsProfileOverlay.classList.add("show");
  }
  function closeKidsProfile() {
    dom.kidsProfileOverlay.classList.remove("show");
  }
  function renderKidsProfileSheet() {
    dom.kidsProfileSheet.innerHTML =
      '<p class="disney-detail-name">👶 아이 키 프로필</p>' +
      '<p class="disney-detail-desc">등록해두면 어트랙션 상세에서 탑승 가능 여부를 바로 확인할 수 있어요(키 제한 정보가 공식 확인된 어트랙션에 한해서요).</p>' +
      '<div id="disneyKidsProfileList">' +
      state.kidsProfile
        .map(
          (kid, idx) =>
            '<div class="disney-kid-row">' +
            '<span>' + escapeHtml(kid.name) + " · " + kid.heightCm + "cm</span>" +
            '<button type="button" data-remove-kid="' + idx + '" aria-label="삭제">✕</button>' +
            "</div>"
        )
        .join("") +
      "</div>" +
      '<div class="disney-kid-form">' +
      '<input type="text" id="disneyKidNameInput" placeholder="이름(예: 담이)" />' +
      '<input type="number" id="disneyKidHeightInput" placeholder="키(cm)" inputmode="numeric" />' +
      '<button type="button" class="btn btn-primary" id="disneyAddKidBtn">추가</button>' +
      "</div>";

    dom.kidsProfileSheet.querySelectorAll("[data-remove-kid]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.kidsProfile.splice(Number(btn.dataset.removeKid), 1);
        persistKidsProfile();
        renderKidsProfileSheet();
      });
    });
    document.getElementById("disneyAddKidBtn").addEventListener("click", () => {
      const name = document.getElementById("disneyKidNameInput").value.trim();
      const height = parseInt(document.getElementById("disneyKidHeightInput").value, 10);
      if (!name || !height) {
        showToast("이름과 키를 입력해주세요");
        return;
      }
      state.kidsProfile.push({ name: name, heightCm: height });
      persistKidsProfile();
      renderKidsProfileSheet();
    });
  }

  // ---------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------
  function bindEvents() {
    dom.searchInput.addEventListener("input", handleSearchInput);
    bindSheetDrag();

    dom.parkSwitcher.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-park]");
      if (btn) switchPark(btn.dataset.park);
    });

    dom.categoryBar.addEventListener("click", (e) => {
      const chip = e.target.closest("[data-category]");
      if (chip) selectCategory(chip.dataset.category);
    });

    dom.restroomFab.addEventListener("click", openRestroomFinder);
    dom.moreBtn.addEventListener("click", toggleMoreMenu);
    dom.moreMenu.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-more-action]");
      if (btn) handleMoreAction(btn.dataset.moreAction);
    });
    dom.kidsProfileBtn.addEventListener("click", openKidsProfile);

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

      const controlledBtn = e.target.closest('[data-action="toggle-controlled"]');
      if (controlledBtn) {
        toggleControlled(controlledBtn.dataset.facilityId);
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
      if (e.target === dom.kidsProfileOverlay) {
        closeKidsProfile();
        return;
      }

      if (state.moreMenuOpen && !e.target.closest("#disneyMoreMenu") && !e.target.closest("#disneyMoreBtn")) {
        closeMoreMenu();
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
