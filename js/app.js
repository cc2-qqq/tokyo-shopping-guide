/**
 * ============================================================================
 * Tokyo Shopping Guide — App Logic
 * ============================================================================
 * TRIP_DATA(js/data.js)를 유일한 데이터 소스로 사용해 화면을 그린다.
 * 이 파일은 렌더링/상태/이벤트만 다루고, 실제 일정 데이터는 절대 하드코딩하지 않는다.
 * ============================================================================
 */
(function () {
  "use strict";

  const STORAGE_KEYS = {
    checklist: "tokyoGuide.checklist.v1",
    donePlaces: "tokyoGuide.donePlaces.v1",
    overrides: "tokyoGuide.overrides.v1",
    memos: "tokyoGuide.memos.v1",
    purchases: "tokyoGuide.purchases.v1",
    budgetLimit: "tokyoGuide.budgetLimit.v1",
  };

  const CATEGORY_LABEL = { mine: "내 쇼핑", wife: "와이프 일정", food: "식당" };
  const CATEGORY_EMOJI = { mine: "🔵", wife: "🟠", food: "🔴" };

  // 쇼핑(내 것/와이프 것)과 별개로 "식당"은 항상 세 번째 색으로 구분해서 보여준다
  function getColorKind(place) {
    return place.costCategory === "food" ? "food" : place.category;
  }
  const WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"];

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  const state = {
    dayIndex: 0,
    checklist: {}, // { brandName: boolean }
    donePlaces: {}, // { placeId: boolean }
    budgetTab: "today", // 'today' | 'trip'
    map: null,
    markerLayer: null,
    routeLayer: null,
    placeMarkers: {}, // { placeId: L.Marker }
    cardObserver: null,
    // 사용자가 앱에서 직접 뺀/추가한 장소 — 원본 데이터(js/data.js)는 그대로 두고
    // 이 오버레이만 기기에 저장해서 "동선 재구성" 결과를 유지한다.
    // { [date]: { placeOrder: [id,...], customPlaces: {id: place}, transportByPlaceId: {id: transport}, fromHotel } }
    overrides: {},
    memos: {}, // { placeId: string }
    expandedMemos: {}, // { placeId: boolean } — 메모 입력창을 펼쳤는지(화면 상태, 저장 안 함)
    purchases: {}, // { placeId: [{ id, item, price, size }] }
    budgetLimit: null, // 사용자가 입력한 총 쇼핑 예산(원 단위 아님, 엔화 숫자)
    userLocation: null, // [lat, lng] — 위치 추적 중일 때만 채워짐(6번: 가까운 다음 목적지 추천용)
    timelineExpanded: false,
    doneGroupExpanded: false,
  };

  const dom = {};
  let toastTimer = null;

  document.addEventListener("DOMContentLoaded", init);

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------
  function init() {
    cacheDom();
    loadStorage();
    renderHeaderStatic();
    renderTripSummary();
    renderDatePills();
    initMap();
    bindGlobalEvents();
    selectDay(getInitialDayIndex(), { animate: false });
  }

  function cacheDom() {
    dom.tripTitle = document.getElementById("tripTitle");
    dom.hotelName = document.getElementById("hotelName");
    dom.tripDatesBadge = document.getElementById("tripDatesBadge");
    dom.tripSummary = document.getElementById("tripSummary");
    dom.datePills = document.getElementById("datePills");
    dom.dayPanel = document.getElementById("dayPanel");
    dom.dayBanner = document.getElementById("dayBanner");
    dom.nowCardWrap = document.getElementById("nowCardWrap");
    dom.dayProgress = document.getElementById("dayProgress");
    dom.cardsScroller = document.getElementById("cardsScroller");
    dom.cardCounter = document.getElementById("cardCounter");
    dom.doneGroup = document.getElementById("doneGroup");
    dom.timeline = document.getElementById("timeline");
    dom.checklist = document.getElementById("checklist");
    dom.checklistProgress = document.getElementById("checklistProgress");
    dom.budgetCard = document.getElementById("budgetCard");
    dom.toast = document.getElementById("toast");
    dom.addPlaceBtn = document.getElementById("addPlaceBtn");
  }

  // ---------------------------------------------------------------------
  // LocalStorage
  // ---------------------------------------------------------------------
  function loadStorage() {
    state.checklist = safeParse(localStorage.getItem(STORAGE_KEYS.checklist)) || {};
    state.donePlaces = safeParse(localStorage.getItem(STORAGE_KEYS.donePlaces)) || {};
    state.overrides = safeParse(localStorage.getItem(STORAGE_KEYS.overrides)) || {};
    state.memos = safeParse(localStorage.getItem(STORAGE_KEYS.memos)) || {};
    state.purchases = safeParse(localStorage.getItem(STORAGE_KEYS.purchases)) || {};
    const savedLimit = safeParse(localStorage.getItem(STORAGE_KEYS.budgetLimit));
    state.budgetLimit = typeof savedLimit === "number" ? savedLimit : null;
  }

  function safeParse(json) {
    try {
      return JSON.parse(json);
    } catch (e) {
      return null;
    }
  }

  function persistChecklist() {
    localStorage.setItem(STORAGE_KEYS.checklist, JSON.stringify(state.checklist));
  }

  function persistDonePlaces() {
    localStorage.setItem(STORAGE_KEYS.donePlaces, JSON.stringify(state.donePlaces));
  }

  function persistMemos() {
    localStorage.setItem(STORAGE_KEYS.memos, JSON.stringify(state.memos));
  }

  function persistPurchases() {
    localStorage.setItem(STORAGE_KEYS.purchases, JSON.stringify(state.purchases));
  }

  function persistBudgetLimit() {
    localStorage.setItem(STORAGE_KEYS.budgetLimit, JSON.stringify(state.budgetLimit));
  }

  function persistOverrides() {
    localStorage.setItem(STORAGE_KEYS.overrides, JSON.stringify(state.overrides));
  }

  // ---------------------------------------------------------------------
  // 유효 일정 계산 — 원본 TRIP_DATA + 사용자가 뺀/추가한 장소를 합쳐서
  // 화면에 실제로 그릴 하루치 데이터를 만든다. TRIP_DATA 자체는 절대 건드리지 않는다.
  // ---------------------------------------------------------------------
  function getOverrideForDate(date) {
    if (!state.overrides[date]) {
      state.overrides[date] = { placeOrder: null, customPlaces: {}, transportByPlaceId: {}, fromHotel: undefined };
    }
    return state.overrides[date];
  }

  function getEffectiveDay(dayIndex) {
    const baseDay = TRIP_DATA.days[dayIndex];
    const override = state.overrides[baseDay.date];
    if (!override || !override.placeOrder) return baseDay;

    const basePlacesById = {};
    baseDay.places.forEach((p) => {
      basePlacesById[p.id] = p;
    });

    const places = override.placeOrder
      .map((id) => {
        const base = basePlacesById[id] || override.customPlaces[id];
        if (!base) return null;
        const hasOverride = Object.prototype.hasOwnProperty.call(override.transportByPlaceId || {}, id);
        const transportToNext = hasOverride ? override.transportByPlaceId[id] : null;
        return Object.assign({}, base, { transportToNext: transportToNext });
      })
      .filter(Boolean);

    return Object.assign({}, baseDay, {
      places: places,
      fromHotel: override.fromHotel !== undefined ? override.fromHotel : baseDay.fromHotel,
    });
  }

  function getAllEffectiveDays() {
    return TRIP_DATA.days.map((_, idx) => getEffectiveDay(idx));
  }

  // 순서가 바뀐 뒤, 숙소→1번째, 1→2번째 ... 구간을 전부 실시간으로 다시 계산해서
  // override에 저장한다. (구간 수가 많지 않고 캐시도 쓰므로 매번 전체를 다시 구해도 가볍다)
  function recomputeDayTransport(dayIndex) {
    const baseDay = TRIP_DATA.days[dayIndex];
    const override = getOverrideForDate(baseDay.date);
    const basePlacesById = {};
    baseDay.places.forEach((p) => {
      basePlacesById[p.id] = p;
    });

    const places = override.placeOrder.map((id) => basePlacesById[id] || override.customPlaces[id]).filter(Boolean);

    const seq = [{ id: null, coords: TRIP_DATA.meta.hotelCoords }].concat(
      places.map((p) => ({ id: p.id, coords: p.coords }))
    );

    const transportByPlaceId = {};
    let chain = Promise.resolve();

    for (let i = 0; i < seq.length - 1; i++) {
      const from = seq[i].coords;
      const to = seq[i + 1].coords;
      const fromId = seq[i].id;
      chain = chain.then(() =>
        estimateTransport(from, to).then((t) => {
          if (fromId === null) {
            override.fromHotel = t;
          } else {
            transportByPlaceId[fromId] = t;
          }
        })
      );
    }

    return chain.then(() => {
      override.transportByPlaceId = transportByPlaceId;
    });
  }

  // 장소 순서를 바꾸는 모든 동작(삭제/추가)의 공통 진입점.
  // mutateOrderFn: 현재 id 순서 배열을 받아 새 순서 배열을 반환
  function applyDayOrderChange(dayIndex, mutateOrderFn, newCustomPlace) {
    const baseDay = TRIP_DATA.days[dayIndex];
    const currentOrder = getEffectiveDay(dayIndex).places.map((p) => p.id);
    const newOrder = mutateOrderFn(currentOrder.slice());

    const override = getOverrideForDate(baseDay.date);
    override.placeOrder = newOrder;
    if (newCustomPlace) {
      override.customPlaces[newCustomPlace.id] = newCustomPlace;
    }

    return recomputeDayTransport(dayIndex).then(() => {
      persistOverrides();
      if (state.dayIndex === dayIndex) {
        rerenderCurrentDay();
      }
    });
  }

  // 카드의 "✕ 제외" 버튼 — 오늘 일정에서 해당 장소를 빼고 남은 지점들로
  // 동선(도보/택시 시간)을 다시 계산한다. 실수로 뺐을 때를 대비해 토스트에
  // "실행 취소" 버튼을 붙여 원래 순서 그대로 되돌릴 수 있게 한다.
  function removePlaceFromDay(dayIndex, placeId) {
    const place = findPlaceById(placeId);
    const currentOrder = getEffectiveDay(dayIndex).places.map((p) => p.id);
    const removedIndex = currentOrder.indexOf(placeId);
    if (removedIndex === -1) return;

    applyDayOrderChange(dayIndex, (order) => order.filter((id) => id !== placeId));
    showToast((place ? place.name : "장소") + " 일정에서 제외됨", {
      label: "실행 취소",
      onClick: () => {
        applyDayOrderChange(dayIndex, (order) => {
          const next = order.slice();
          next.splice(removedIndex, 0, placeId);
          return next;
        });
      },
    });
  }

  // ---------------------------------------------------------------------
  // 구글맵 링크로 장소 추가
  // 짧은 링크(maps.app.goo.gl)는 서버 없이는 클라이언트에서 안전하게 풀 수
  // 없어서(공용 CORS 프록시들이 계속 막혀 있음), 위경도가 URL에 그대로 담긴
  // "전체" 링크(@lat,lng 또는 !3d..!4d..)만 정규식으로 즉시 파싱한다.
  // ---------------------------------------------------------------------
  function parseGoogleMapsUrl(rawUrl) {
    const url = (rawUrl || "").trim();
    let hostname = "";
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch (e) {
      return { error: "invalid" };
    }
    if (hostname.endsWith("goo.gl")) {
      return { error: "short-link" };
    }

    const dMatch = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    const atMatch = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    let lat, lng;
    if (dMatch) {
      lat = parseFloat(dMatch[1]);
      lng = parseFloat(dMatch[2]);
    } else if (atMatch) {
      lat = parseFloat(atMatch[1]);
      lng = parseFloat(atMatch[2]);
    } else {
      return { error: "not-found" };
    }

    let name = "";
    const placeMatch = url.match(/\/place\/([^/@]+)/);
    if (placeMatch) {
      name = decodeURIComponent(placeMatch[1].replace(/\+/g, " "));
    }

    return { lat: lat, lng: lng, name: name };
  }

  function addPlaceToDay(dayIndex, url, nameInput, categoryKind, insertAfterId) {
    const parsed = parseGoogleMapsUrl(url);
    if (parsed.error === "short-link") {
      showToast("짧은 링크는 인식할 수 없어요. 링크를 한 번 열어서 나온 전체 주소를 붙여넣어 주세요.");
      return false;
    }
    if (parsed.error) {
      showToast("링크에서 위치를 찾을 수 없어요. 구글맵에서 매장을 연 상태의 링크를 사용해주세요.");
      return false;
    }

    const name = (nameInput && nameInput.trim()) || parsed.name || "새로 추가한 장소";
    const id = "custom-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const place = {
      id: id,
      name: name,
      address: "직접 추가한 장소",
      coords: [parsed.lat, parsed.lng],
      category: categoryKind === "food" ? "mine" : categoryKind,
      costCategory: categoryKind === "food" ? "food" : undefined,
      // 이름 검색 대신 좌표 자체로 열어서, 방금 붙여넣은 링크와 항상 정확히 같은 지점이 뜨게 한다
      googleMapsQuery: parsed.lat + "," + parsed.lng,
      recommendedDuration: "1시간",
      rating: 0,
      isCustom: true,
    };

    applyDayOrderChange(
      dayIndex,
      (order) => {
        const next = order.slice();
        if (!insertAfterId) {
          next.unshift(id);
        } else {
          const idx = next.indexOf(insertAfterId);
          next.splice(idx + 1, 0, id);
        }
        return next;
      },
      place
    );

    showToast(name + " 오늘 일정에 추가됨");
    return true;
  }

  function buildAddPlaceModal() {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML =
      '<div class="modal-sheet">' +
      '<div class="modal-header"><h3>장소 추가</h3><button type="button" class="modal-close" id="addPlaceClose">✕</button></div>' +
      '<div class="modal-body">' +
      '<label class="modal-field"><span class="modal-field-label">구글맵 링크</span>' +
      '<input type="url" id="addPlaceUrlInput" placeholder="https://www.google.com/maps/place/..." /></label>' +
      '<p class="modal-hint">전체 주소가 담긴 링크를 붙여넣어 주세요. 짧은 링크(maps.app.goo.gl)는 한 번 열어서 나온 전체 링크를 복사해주세요.</p>' +
      '<label class="modal-field"><span class="modal-field-label">매장명 (선택)</span>' +
      '<input type="text" id="addPlaceNameInput" placeholder="비워두면 링크에서 자동으로 가져와요" /></label>' +
      '<label class="modal-field"><span class="modal-field-label">분류</span>' +
      '<div class="modal-radio-group">' +
      '<label><input type="radio" name="addPlaceCategory" value="mine" checked />내 쇼핑</label>' +
      '<label><input type="radio" name="addPlaceCategory" value="wife" />와이프 일정</label>' +
      '<label><input type="radio" name="addPlaceCategory" value="food" />식당</label>' +
      "</div></label>" +
      '<label class="modal-field"><span class="modal-field-label">추가 위치</span>' +
      '<select id="addPlaceInsertSelect"></select></label>' +
      "</div>" +
      '<div class="modal-actions">' +
      '<button type="button" class="btn btn-outline" id="addPlaceCancel">취소</button>' +
      '<button type="button" class="btn btn-primary" id="addPlaceSubmit">추가하기</button>' +
      "</div></div>";
    document.body.appendChild(overlay);

    dom.addPlaceOverlay = overlay;
    dom.addPlaceUrlInput = overlay.querySelector("#addPlaceUrlInput");
    dom.addPlaceNameInput = overlay.querySelector("#addPlaceNameInput");
    dom.addPlaceInsertSelect = overlay.querySelector("#addPlaceInsertSelect");

    overlay.querySelector("#addPlaceClose").addEventListener("click", closeAddPlaceModal);
    overlay.querySelector("#addPlaceCancel").addEventListener("click", closeAddPlaceModal);
    overlay.querySelector("#addPlaceSubmit").addEventListener("click", submitAddPlaceForm);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeAddPlaceModal();
    });
  }

  function openAddPlaceModal() {
    if (!dom.addPlaceOverlay) buildAddPlaceModal();
    const overlay = dom.addPlaceOverlay;

    dom.addPlaceUrlInput.value = "";
    dom.addPlaceNameInput.value = "";
    overlay.querySelector('input[name="addPlaceCategory"][value="mine"]').checked = true;

    const day = getEffectiveDay(state.dayIndex);
    const options = ['<option value="">맨 처음에 추가</option>'].concat(
      day.places.map((p) => '<option value="' + p.id + '">' + escapeHtml(p.name) + " 다음에 추가</option>")
    );
    dom.addPlaceInsertSelect.innerHTML = options.join("");
    if (day.places.length > 0) {
      dom.addPlaceInsertSelect.value = day.places[day.places.length - 1].id;
    }

    overlay.classList.add("show");
  }

  function closeAddPlaceModal() {
    if (dom.addPlaceOverlay) dom.addPlaceOverlay.classList.remove("show");
  }

  function submitAddPlaceForm() {
    const overlay = dom.addPlaceOverlay;
    const url = dom.addPlaceUrlInput.value.trim();
    if (!url) {
      showToast("구글맵 링크를 입력해주세요");
      return;
    }
    const category = overlay.querySelector('input[name="addPlaceCategory"]:checked').value;
    const insertAfterId = dom.addPlaceInsertSelect.value;

    const ok = addPlaceToDay(state.dayIndex, url, dom.addPlaceNameInput.value, category, insertAfterId);
    if (ok) closeAddPlaceModal();
  }

  function rerenderCurrentDay() {
    const day = getEffectiveDay(state.dayIndex);
    renderMapForDay(day);
    renderCards(day);
    renderTimeline(day);
    renderBudget();
    renderChecklist();
    renderNowCard(day);
    renderTripSummary();
  }

  // ---------------------------------------------------------------------
  // "지금 갈 곳" — 오늘 남은 장소 중 어디로 가야 하는지 항상 눈에 띄게 보여준다.
  // 위치 추적이 켜져 있으면(6번) 가장 가까운 미완료 장소, 꺼져 있으면 원래
  // 방문 순서상 다음 미완료 장소를 그대로 사용한다.
  // ---------------------------------------------------------------------
  function getCurrentTarget(day) {
    const pending = day.places.filter((p) => !state.donePlaces[p.id]);
    if (pending.length === 0) return { current: null, next: null };

    let current = pending[0];
    if (state.userLocation) {
      let minDist = Infinity;
      pending.forEach((p) => {
        const d = haversineMeters(state.userLocation, p.coords);
        if (d < minDist) {
          minDist = d;
          current = p;
        }
      });
    }
    const next = pending[pending.indexOf(current) + 1] || null;
    return { current: current, next: next };
  }

  // 원래 방문 순서에서 이 장소 "바로 앞"의 이동 정보(숙소 출발이면 fromHotel).
  // 위치 추적이 꺼져 있을 때 "지금 여기까지 얼마나 걸리는지"의 근사치로 쓴다.
  function getIncomingTransport(day, place) {
    const idx = day.places.findIndex((p) => p.id === place.id);
    if (idx <= 0) return day.fromHotel;
    return day.places[idx - 1].transportToNext;
  }

  function renderNowCard(day) {
    if (!dom.nowCardWrap) return;
    const { current, next } = getCurrentTarget(day);

    if (!current) {
      dom.nowCardWrap.innerHTML = day.places.length
        ? '<div class="now-card done-all">🎉 오늘 일정을 모두 완료했습니다!</div>'
        : "";
      return;
    }

    const transport = state.userLocation
      ? fallbackTransport(state.userLocation, current.coords)
      : getIncomingTransport(day, current);
    const transportHtml = transport
      ? '<span class="now-card-transport">' +
        (transport.mode === "walk" ? "🚶" : "🚕") +
        " " +
        transport.time +
        (state.userLocation ? " (현재 위치 기준)" : "") +
        "</span>"
      : "";

    dom.nowCardWrap.innerHTML =
      '<div class="now-card ' +
      getColorKind(current) +
      '">' +
      '<div class="now-card-label">NOW · 지금 갈 곳</div>' +
      '<div class="now-card-body">' +
      '<p class="now-card-name">' +
      escapeHtml(formatPlaceName(current)) +
      "</p>" +
      '<div class="now-card-meta">' +
      transportHtml +
      '<span class="now-card-duration">체류 ' +
      escapeHtml(current.recommendedDuration) +
      "</span>" +
      "</div>" +
      "</div>" +
      '<button type="button" class="btn btn-primary now-card-maps-btn" data-action="maps" data-query="' +
      encodeURIComponent(current.googleMapsQuery || current.name + " " + current.address) +
      '">📍 Google Maps</button>' +
      (next
        ? '<div class="now-card-next">다음: ' + escapeHtml(formatPlaceName(next)) + "</div>"
        : "") +
      "</div>";
  }

  // ---------------------------------------------------------------------
  // Header
  // ---------------------------------------------------------------------
  function renderHeaderStatic() {
    dom.tripTitle.textContent = TRIP_DATA.meta.title;
    dom.hotelName.textContent = TRIP_DATA.meta.hotelName;
    dom.tripDatesBadge.textContent =
      formatMonthDay(TRIP_DATA.meta.startDate) + " – " + formatMonthDay(TRIP_DATA.meta.endDate);
  }

  function formatMonthDay(dateStr) {
    const d = new Date(dateStr + "T00:00:00");
    return d.getMonth() + 1 + "/" + d.getDate();
  }

  function formatWeekday(dateStr) {
    const d = new Date(dateStr + "T00:00:00");
    return WEEKDAY_KO[d.getDay()];
  }

  function getInitialDayIndex() {
    const todayStr = new Date().toISOString().slice(0, 10);
    const idx = TRIP_DATA.days.findIndex((d) => d.date === todayStr);
    return idx >= 0 ? idx : 0;
  }

  // ---------------------------------------------------------------------
  // Date pills
  // ---------------------------------------------------------------------
  function renderDatePills() {
    dom.datePills.innerHTML = "";
    TRIP_DATA.days.forEach((day, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "date-pill";
      btn.setAttribute("role", "tab");
      btn.dataset.index = String(idx);
      btn.innerHTML =
        '<span class="weekday">' + formatWeekday(day.date) + "</span>" + formatMonthDay(day.date);
      btn.addEventListener("click", (e) => {
        addRipple(btn, e);
        if (idx === state.dayIndex) return;
        selectDay(idx, { animate: true, direction: idx > state.dayIndex ? "left" : "right" });
      });
      dom.datePills.appendChild(btn);
    });
    updateActivePill();
  }

  function updateActivePill() {
    const pills = dom.datePills.querySelectorAll(".date-pill");
    pills.forEach((p) => {
      const isActive = Number(p.dataset.index) === state.dayIndex;
      p.classList.toggle("active", isActive);
      p.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    const activePill = pills[state.dayIndex];
    if (activePill) {
      activePill.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    }
  }

  // ---------------------------------------------------------------------
  // Day selection — 부드러운 슬라이드 전환
  // ---------------------------------------------------------------------
  function selectDay(idx, opts) {
    opts = opts || {};
    const panel = dom.dayPanel;

    function renderDayContent() {
      state.dayIndex = idx;
      state.doneGroupExpanded = false;
      state.timelineExpanded = false;
      updateActivePill();
      const day = getEffectiveDay(idx);
      renderBanner(day);
      renderNowCard(day);
      renderMapForDay(day);
      renderCards(day);
      renderTimeline(day);
      renderChecklist();
      renderBudget();
    }

    if (!opts.animate) {
      renderDayContent();
      return;
    }

    const outX = opts.direction === "left" ? "-14px" : "14px";
    const inX = opts.direction === "left" ? "14px" : "-14px";

    panel.style.transition = "opacity .15s ease, transform .15s ease";
    panel.style.opacity = "0";
    panel.style.transform = "translateX(" + outX + ")";

    setTimeout(() => {
      renderDayContent();
      panel.style.transition = "none";
      panel.style.transform = "translateX(" + inX + ")";
      void panel.offsetWidth; // reflow
      panel.style.transition = "opacity .22s ease, transform .22s ease";
      requestAnimationFrame(() => {
        panel.style.opacity = "1";
        panel.style.transform = "translateX(0)";
      });
    }, 150);
  }

  // ---------------------------------------------------------------------
  // Map
  // ---------------------------------------------------------------------
  function initMap() {
    state.map = L.map("map", {
      zoomControl: false,
      attributionControl: true,
    }).setView(TRIP_DATA.meta.hotelCoords, 14);

    // Apple Maps 톤에 가까운 밝고 미니멀한 타일
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
      maxZoom: 19,
      subdomains: "abcd",
    }).addTo(state.map);

    L.control.zoom({ position: "bottomright" }).addTo(state.map);

    state.markerLayer = L.layerGroup().addTo(state.map);
    state.routeLayer = L.layerGroup().addTo(state.map);
    state.stationLayer = L.layerGroup().addTo(state.map);
    state.extraShopLayer = L.layerGroup().addTo(state.map);
    state.userLocationLayer = L.layerGroup().addTo(state.map);

    renderStations();
    renderExtraShops();
    addLocateControl();
  }

  // ---------------------------------------------------------------------
  // 내 현재 위치 — 실제 여행 중 지도에서 "지금 내가 어디 있는지" 확인용.
  // 버튼을 누르면 위치 추적을 시작하고(파란 점이 실시간으로 따라옴),
  // 다시 누르면 추적을 끈다. 위치 정보는 브라우저 권한이 필요하다.
  // ---------------------------------------------------------------------
  function addLocateControl() {
    const LocateControl = L.Control.extend({
      options: { position: "bottomright" },
      onAdd: function () {
        const container = L.DomUtil.create("div", "leaflet-bar locate-control");
        const button = L.DomUtil.create("a", "locate-button", container);
        button.href = "#";
        button.title = "내 현재 위치";
        button.innerHTML = "🎯";
        L.DomEvent.on(button, "click", (e) => {
          L.DomEvent.preventDefault(e);
          L.DomEvent.stopPropagation(e);
          toggleGeolocation(button);
        });
        return container;
      },
    });
    state.map.addControl(new LocateControl());
  }

  function toggleGeolocation(button) {
    if (state.watchId != null) {
      navigator.geolocation.clearWatch(state.watchId);
      state.watchId = null;
      state.userLocation = null;
      state.userLocationLayer.clearLayers();
      button.classList.remove("active");
      renderNowCard(getEffectiveDay(state.dayIndex));
      return;
    }

    if (!navigator.geolocation) {
      showToast("이 브라우저에서는 위치 확인을 지원하지 않아요");
      return;
    }

    button.classList.add("active");
    let firstFix = true;

    state.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        renderUserLocation(pos);
        if (firstFix) {
          state.map.setView([pos.coords.latitude, pos.coords.longitude], 16);
          firstFix = false;
        }
      },
      (err) => {
        button.classList.remove("active");
        state.watchId = null;
        const messages = {
          1: "위치 권한이 꺼져 있어요. 브라우저 설정에서 위치 접근을 허용해주세요.",
          2: "현재 위치를 확인할 수 없어요.",
          3: "위치 확인이 너무 오래 걸려요. 다시 시도해주세요.",
        };
        showToast(messages[err.code] || "위치 확인에 실패했어요");
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
    );
  }

  function renderUserLocation(pos) {
    const latlng = [pos.coords.latitude, pos.coords.longitude];
    const accuracy = pos.coords.accuracy || 30;
    state.userLocation = latlng;
    renderNowCard(getEffectiveDay(state.dayIndex));
    state.userLocationLayer.clearLayers();

    L.circle(latlng, {
      radius: accuracy,
      color: "#007AFF",
      weight: 1,
      fillColor: "#007AFF",
      fillOpacity: 0.12,
    }).addTo(state.userLocationLayer);

    const icon = L.divIcon({
      className: "",
      html: '<div class="user-location-wrap"><div class="user-location-pulse"></div><div class="user-location-dot"></div></div>',
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
    L.marker(latlng, { icon: icon, interactive: false, zIndexOffset: 500 }).addTo(state.userLocationLayer);
  }

  // 일정에는 없지만 도쿄 곳곳에 지점이 있는 편집숍/구제샵 — "여유 있으면 들러볼" 참고 마커.
  // 점선 테두리로 표시해서 확정된 방문지(실선 라벨)와 구분하고, 탭하면 바로 구글맵으로 연결한다.
  function renderExtraShops() {
    (TRIP_DATA.extraShops || []).forEach((shop) => {
      const html =
        '<div class="map-label-wrap"><div class="map-label extra-shop-label" title="' +
        escapeHtml(shop.address) +
        '">🏷️ ' +
        escapeHtml(shop.name) +
        "</div></div>";
      const icon = L.divIcon({ className: "", html: html, iconSize: [0, 0], iconAnchor: [0, 0] });
      const marker = L.marker(shop.coords, { icon: icon, zIndexOffset: -50 });
      marker.on("click", () => {
        const url = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(shop.googleMapsQuery);
        window.open(url, "_blank", "noopener");
        showToast(shop.name + " · Google Maps로 이동");
      });
      marker.addTo(state.extraShopLayer);
    });
  }

  // 주요 역 — 날짜가 바뀌어도 다시 그리지 않고 한 번만 표시해 둔다.
  // 매장 라벨보다 눈에 덜 띄게(작고 흐리게) 만들어서 쇼핑 동선을 가리지 않게 한다.
  function renderStations() {
    (TRIP_DATA.stations || []).forEach((station) => {
      const html =
        '<div class="map-label-wrap"><div class="station-label">🚉 ' +
        escapeHtml(station.name) +
        "</div></div>";
      const icon = L.divIcon({ className: "", html: html, iconSize: [0, 0], iconAnchor: [0, 0] });
      L.marker(station.coords, { icon: icon, interactive: false, zIndexOffset: -100 }).addTo(
        state.stationLayer
      );
    });
  }

  function renderMapForDay(day) {
    state.markerLayer.clearLayers();
    state.routeLayer.clearLayers();
    state.placeMarkers = {};

    const hotelCoords = TRIP_DATA.meta.hotelCoords;

    // 숙소 마커
    const hotelIcon = L.divIcon({
      className: "",
      html: '<div class="map-label-hotel">🏨</div>',
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });
    L.marker(hotelCoords, { icon: hotelIcon, zIndexOffset: 100, interactive: false }).addTo(
      state.markerLayer
    );

    // 숙소 → 장소1 → 장소2 → ... 순서의 이동 구간을 순회하며 선을 그린다
    const segments = [{ coords: hotelCoords, transport: day.fromHotel }].concat(
      day.places.map((p) => ({ coords: p.coords, transport: p.transportToNext }))
    );

    for (let i = 0; i < segments.length - 1; i++) {
      const transport = segments[i].transport;
      if (!transport) continue;
      drawRoute(segments[i].coords, segments[i + 1].coords, transport);
    }

    // 브랜드명이 그대로 보이는 라벨 마커 + 정확한 좌표를 찍는 작은 순번 핀
    // (숫자만 있는 마커가 아니라, 이름표 옆에 방문 순서를 보조로 붙이는 방식)
    const bounds = [hotelCoords];
    day.places.forEach((place, idx) => {
      bounds.push(place.coords);
      addPlaceLabel(place, idx + 1);
    });

    if (day.places.length === 0) {
      // 방문 예정 매장이 없는 날(예: 출국일)은 숙소를 중심으로 보여준다
      state.map.setView(hotelCoords, 15);
      return;
    }

    // 상하좌우 여백을 넉넉히 둬서, 라벨이 옆으로 넓거나 위로 쌓일 때도
    // 지도 밖으로 잘리지 않게 한다
    state.map.fitBounds(bounds, {
      paddingTopLeft: [140, 230],
      paddingBottomRight: [140, 60],
      maxZoom: 15,
    });

    // 동선이 넓게 퍼져 있으면(예: 먼 액티비티 포함) 너무 축소되어 라벨이
    // 서로 겹치므로, 최소 줌 레벨을 보장해 가까운 매장들은 항상 읽히게 한다.
    const MIN_LABEL_ZOOM = 13;
    if (state.map.getZoom() < MIN_LABEL_ZOOM) {
      state.map.setZoom(MIN_LABEL_ZOOM);
    }

    // fitBounds/setZoom 애니메이션이 끝난 뒤, 서로 가까워서 겹치는 라벨들을
    // 자동으로 위로 쌓아 올려 항상 브랜드명을 읽을 수 있게 한다.
    setTimeout(() => declutterLabels(day), 320);
  }

  // 지도 픽셀 좌표 기준으로 라벨 박스가 겹치면 상/좌/우로 옮겨가며 충돌을 피한다.
  // 매장이 아주 촘촘하게 몰린 날(예: 하라주쿠 하루 8곳)에도 라벨이 서로
  // 가리지 않도록 위쪽뿐 아니라 옆쪽 후보 위치까지 순서대로 시도한다.
  const LABEL_CANDIDATES = [
    [0, 0],
    [0, 1],
    [1, 0],
    [-1, 0],
    [1, 1],
    [-1, 1],
    [0, 2],
    [2, 0],
    [-2, 0],
    [1, 2],
    [-1, 2],
    [2, 1],
    [-2, 1],
    [0, 3],
    [2, 2],
    [-2, 2],
    [3, 0],
    [-3, 0],
    [0, 4],
    [3, 1],
    [-3, 1],
  ];

  function declutterLabels(day) {
    const placedRects = [];

    // 이동 경로 위의 시간/비용 칩도 자리를 이미 차지한 것으로 취급해서
    // 매장 라벨이 칩 위에 겹쳐 쓰이지 않게 한다.
    const mapRect = state.map.getContainer().getBoundingClientRect();
    state.map
      .getContainer()
      .querySelectorAll(".route-chip")
      .forEach((chip) => {
        const r = chip.getBoundingClientRect();
        placedRects.push({
          left: r.left - mapRect.left,
          right: r.right - mapRect.left,
          top: r.top - mapRect.top,
          bottom: r.bottom - mapRect.top,
        });
      });

    day.places.forEach((place) => {
      const marker = state.placeMarkers[place.id];
      if (!marker) return;
      const el = marker.getElement();
      if (!el) return;
      const wrap = el.querySelector(".map-label-wrap");
      const label = el.querySelector(".map-label");
      if (!wrap || !label) return;

      const point = state.map.latLngToContainerPoint(place.coords);
      const width = label.offsetWidth;
      const height = label.offsetHeight;
      const stepX = width + 6;
      const stepY = height + 4;

      let chosen = null;
      for (const [dx, dy] of LABEL_CANDIDATES) {
        const centerX = point.x + dx * stepX;
        const bottomOffset = 6 + dy * stepY;
        const top = point.y - bottomOffset - height;
        const rect = { left: centerX - width / 2, right: centerX + width / 2, top: top, bottom: top + height };
        if (!placedRects.some((r) => rectsOverlap(rect, r))) {
          chosen = { dx: dx, dy: dy, rect: rect, bottomOffset: bottomOffset };
          break;
        }
      }
      if (!chosen) {
        const [dx, dy] = LABEL_CANDIDATES[LABEL_CANDIDATES.length - 1];
        const centerX = point.x + dx * stepX;
        const bottomOffset = 6 + dy * stepY;
        const top = point.y - bottomOffset - height;
        chosen = {
          dx: dx,
          dy: dy,
          rect: { left: centerX - width / 2, right: centerX + width / 2, top: top, bottom: top + height },
          bottomOffset: bottomOffset,
        };
      }

      placedRects.push(chosen.rect);

      if (chosen.dx !== 0 || chosen.dy !== 0) {
        const dxPx = chosen.dx * stepX;
        const riseFromAnchor = chosen.bottomOffset - 6;
        label.style.left = dxPx + "px";
        label.style.bottom = chosen.bottomOffset + "px";
        label.classList.add("stacked");

        // 매장 실제 위치(앵커)와 이동된 라벨을 점선으로 이어준다
        const length = Math.sqrt(dxPx * dxPx + riseFromAnchor * riseFromAnchor);
        const angle = (Math.atan2(-riseFromAnchor, dxPx) * 180) / Math.PI;
        const leader = document.createElement("div");
        leader.className = "label-leader";
        leader.style.width = length + "px";
        leader.style.transform = "rotate(" + angle + "deg)";
        wrap.appendChild(leader);
      }
    });
  }

  function rectsOverlap(a, b) {
    return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
  }

  // ---------------------------------------------------------------------
  // 실제 도로를 따라가는 경로 — OSRM 공개 데모 서버(무료, API 키 불필요)로
  // 도보/자동차 경로 좌표를 받아온다. 실패하거나 오프라인이면 직선으로
  // 자연스럽게 대체되므로 지도가 깨지지 않는다.
  // ---------------------------------------------------------------------
  const ROUTE_INFO_CACHE = {}; // "mode:lat,lng-lat,lng" -> {coords, duration(초), distance(m)} | null
  let routeFetchQueue = Promise.resolve(); // 데모 서버 권장치(초당 1건)를 넘지 않도록 순차 처리

  function fetchWithTimeout(url, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), ms);
      fetch(url).then(
        (res) => {
          clearTimeout(timer);
          resolve(res);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  function fetchRouteInfo(from, to, mode) {
    const profile = mode === "walk" ? "foot" : "driving";
    const url =
      "https://router.project-osrm.org/route/v1/" +
      profile +
      "/" +
      from[1] +
      "," +
      from[0] +
      ";" +
      to[1] +
      "," +
      to[0] +
      "?overview=full&geometries=geojson";

    return fetchWithTimeout(url, 6000)
      .then((res) => {
        if (!res.ok) throw new Error("bad status");
        return res.json();
      })
      .then((data) => {
        if (data.code !== "Ok" || !data.routes || !data.routes[0]) throw new Error("no route");
        const route = data.routes[0];
        return {
          coords: route.geometry.coordinates.map((c) => [c[1], c[0]]),
          duration: route.duration, // 초
          distance: route.distance, // 미터
        };
      });
  }

  function getRouteInfoQueued(from, to, mode) {
    const key = mode + ":" + from.join(",") + "-" + to.join(",");
    if (key in ROUTE_INFO_CACHE) {
      return Promise.resolve(ROUTE_INFO_CACHE[key]);
    }
    const run = routeFetchQueue.then(
      () =>
        new Promise((resolve) => {
          fetchRouteInfo(from, to, mode).then(
            (info) => {
              ROUTE_INFO_CACHE[key] = info;
              resolve(info);
            },
            () => {
              ROUTE_INFO_CACHE[key] = null; // 실패도 캐싱해서 같은 구간 재요청 방지
              resolve(null);
            }
          );
        })
    );
    // 다음 요청은 이 요청이 끝난 뒤 살짝 텀을 두고 실행 (데모 서버 과호출 방지)
    routeFetchQueue = run.then(() => new Promise((r) => setTimeout(r, 150)));
    return run;
  }

  function drawRoute(from, to, transport) {
    const isWalk = transport.mode === "walk";
    const line = L.polyline([from, to], {
      color: isWalk ? "#34C759" : "#007AFF",
      weight: isWalk ? 3.5 : 4.5,
      opacity: 0.9,
      dashArray: isWalk ? "1, 10" : null,
      lineCap: "round",
    });
    line.addTo(state.routeLayer);

    const straightMid = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
    const icon = isWalk ? "🚶" : "🚕";
    const costText = transport.cost ? " · ¥" + transport.cost.toLocaleString() : "";
    const chipIcon = L.divIcon({
      className: "",
      html:
        '<div class="route-chip-wrap"><div class="route-chip">' +
        icon +
        " " +
        transport.time +
        costText +
        "</div></div>",
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
    const chip = L.marker(straightMid, { icon: chipIcon, interactive: false }).addTo(state.routeLayer);

    // 실제 도로 경로가 도착하면 직선을 실제 동선으로 교체한다
    getRouteInfoQueued(from, to, transport.mode).then((info) => {
      if (!info || !info.coords || info.coords.length < 2) return; // 실패 시 직선 그대로 유지
      if (!state.map.hasLayer(line)) return; // 그 사이 다른 날짜로 넘어갔으면 무시
      line.setLatLngs(info.coords);
      chip.setLatLng(info.coords[Math.floor(info.coords.length / 2)]);
    });
  }

  // ---------------------------------------------------------------------
  // 장소를 빼거나 넣었을 때, 새로 이어지는 두 지점 사이의 이동수단/시간/비용을
  // 실시간으로 추정한다 — 도보 20분 이내면 도보, 아니면 택시로 판단하고
  // 택시 요금은 도쿄 기본요금 체계로 근사한다. OSRM이 실패하면 직선거리로 대체.
  // ---------------------------------------------------------------------
  function haversineMeters(a, b) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b[0] - a[0]);
    const dLng = toRad(b[1] - a[1]);
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  // 2026년 도쿄 소형 택시 기준 근사치 (초기요금 1.052km까지 500엔, 이후 237m당 100엔)
  function estimateTaxiFare(meters) {
    if (meters <= 1052) return 500;
    return 500 + Math.ceil((meters - 1052) / 237) * 100;
  }

  function estimateTransport(fromCoords, toCoords) {
    return getRouteInfoQueued(fromCoords, toCoords, "walk")
      .then((walkInfo) => {
        if (walkInfo && walkInfo.duration <= 20 * 60) {
          return { mode: "walk", time: Math.max(1, Math.round(walkInfo.duration / 60)) + "분", cost: 0 };
        }
        return getRouteInfoQueued(fromCoords, toCoords, "taxi").then((driveInfo) => {
          if (driveInfo) {
            return {
              mode: "taxi",
              time: Math.max(3, Math.round(driveInfo.duration / 60)) + "분",
              cost: estimateTaxiFare(driveInfo.distance),
            };
          }
          return fallbackTransport(fromCoords, toCoords);
        });
      })
      .catch(() => fallbackTransport(fromCoords, toCoords));
  }

  // OSRM이 아예 응답하지 않을 때(오프라인 등) 직선거리로 대충이라도 추정
  function fallbackTransport(fromCoords, toCoords) {
    const straight = haversineMeters(fromCoords, toCoords);
    if (straight <= 1000) {
      return { mode: "walk", time: Math.max(1, Math.round(straight / 80)) + "분", cost: 0 };
    }
    const roadDistance = straight * 1.3; // 직선 대비 실도로 보정치
    const minutes = Math.max(3, Math.round(((roadDistance / 1000) * 60) / 25)); // 시속 25km 가정
    return { mode: "taxi", time: minutes + "분", cost: estimateTaxiFare(roadDistance) };
  }

  // "20분" 같은 표시용 문자열에서 분(숫자)만 뽑아낸다 — 여행 요약의 총 이동시간 합산용
  function parseMinutes(timeStr) {
    if (!timeStr) return 0;
    const m = String(timeStr).match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
  }

  function addPlaceLabel(place, order) {
    const isDone = !!state.donePlaces[place.id];
    const colorKind = getColorKind(place);
    const emoji = CATEGORY_EMOJI[colorKind];
    // 라벨이 겹쳐서 옆으로 밀리더라도, 정확한 좌표에는 항상 작은 핀이 고정으로 찍혀 있는다
    // (구글맵처럼 "정확한 지점"과 "읽기 편한 이름표"를 분리). 핀 안의 숫자는 방문 순서로,
    // 카드 목록의 같은 번호와 매칭된다 — 브랜드명은 그대로 다 보이니 번호만 있는 마커와는 다르다.
    const html =
      '<div class="map-label-wrap">' +
      '<div class="map-pin-dot ' +
      colorKind +
      (isDone ? " done" : "") +
      '">' +
      order +
      "</div>" +
      '<div class="map-label ' +
      colorKind +
      (isDone ? " done" : "") +
      '" data-place-id="' +
      place.id +
      '">' +
      emoji +
      " " +
      escapeHtml(place.name) +
      "</div></div>";

    const icon = L.divIcon({ className: "", html: html, iconSize: [0, 0], iconAnchor: [0, 0] });
    const marker = L.marker(place.coords, { icon: icon, riseOnHover: true });
    marker.on("click", () => goToPlace(place.id));
    marker.addTo(state.markerLayer);
    state.placeMarkers[place.id] = marker;
  }

  function setActiveMapLabel(placeId) {
    Object.keys(state.placeMarkers).forEach((id) => {
      const marker = state.placeMarkers[id];
      const el = marker.getElement();
      if (!el) return;
      const label = el.querySelector(".map-label");
      if (!label) return;
      label.classList.toggle("active", id === placeId);
    });
  }

  function updateMapDoneStates() {
    Object.keys(state.placeMarkers).forEach((id) => {
      const marker = state.placeMarkers[id];
      const el = marker.getElement();
      if (!el) return;
      const isDone = !!state.donePlaces[id];
      const label = el.querySelector(".map-label");
      if (label) label.classList.toggle("done", isDone);
      const dot = el.querySelector(".map-pin-dot");
      if (dot) dot.classList.toggle("done", isDone);
    });
  }

  // 카드 ↔ 지도 동기화: 특정 장소로 지도를 이동시키고 카드도 스크롤
  function goToPlace(placeId) {
    const card = dom.cardsScroller.querySelector('[data-card-id="' + placeId + '"]');
    if (card) card.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    setActiveMapLabel(placeId);
    const place = findPlaceById(placeId);
    if (place && state.map) state.map.panTo(place.coords, { animate: true });
  }

  // ---------------------------------------------------------------------
  // Cards
  // ---------------------------------------------------------------------
  function renderCards(day) {
    dom.cardsScroller.innerHTML = "";
    dom.cardCounter.textContent = day.places.length + "곳";
    renderDayProgress(day);
    renderDoneGroup(day);

    if (day.places.length === 0) {
      dom.cardsScroller.innerHTML = '<p class="empty-note">오늘은 예정된 매장이 없습니다 🧳</p>';
      if (state.cardObserver) state.cardObserver.disconnect();
      return;
    }

    const pending = day.places.filter((p) => !state.donePlaces[p.id]);
    if (pending.length === 0) {
      dom.cardsScroller.innerHTML = '<p class="empty-note">오늘 일정을 모두 완료했습니다 🎉</p>';
      if (state.cardObserver) state.cardObserver.disconnect();
      return;
    }

    // idx는 항상 day.places(원본 방문 순서) 기준 — "다음 카드" 이동시간 체인이
    // 이 순서를 기준으로 계산돼 있으므로, 완료 카드를 화면에서 감추더라도 절대 바뀌면 안 된다.
    pending.forEach((place) => {
      const idx = day.places.indexOf(place);
      dom.cardsScroller.appendChild(buildPlaceCard(place, day, idx));
    });

    if (state.cardObserver) state.cardObserver.disconnect();
    state.cardObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && entry.intersectionRatio > 0.6) {
            const id = entry.target.dataset.cardId;
            setActiveMapLabel(id);
            const place = findPlaceById(id);
            if (place && state.map) state.map.panTo(place.coords, { animate: true });
          }
        });
      },
      { root: dom.cardsScroller, threshold: [0.6] }
    );
    dom.cardsScroller.querySelectorAll(".place-card").forEach((el) => state.cardObserver.observe(el));
  }

  // ---------------------------------------------------------------------
  // 오늘 진행률 바 + 완료한 장소 접이식 목록
  // ---------------------------------------------------------------------
  function renderDayProgress(day) {
    if (!dom.dayProgress) return;
    const total = day.places.length;
    if (total === 0) {
      dom.dayProgress.innerHTML = "";
      return;
    }
    const done = day.places.filter((p) => state.donePlaces[p.id]).length;
    const pct = Math.round((done / total) * 100);
    dom.dayProgress.innerHTML =
      '<div class="day-progress-label">오늘 진행률 <strong>' +
      done +
      " / " +
      total +
      "</strong> 완료</div>" +
      '<div class="day-progress-bar"><div class="day-progress-fill" style="width:' +
      pct +
      '%"></div></div>';
  }

  function renderDoneGroup(day) {
    if (!dom.doneGroup) return;
    const doneItems = day.places.filter((p) => state.donePlaces[p.id]);
    if (doneItems.length === 0) {
      dom.doneGroup.innerHTML = "";
      return;
    }
    const expanded = state.doneGroupExpanded;
    dom.doneGroup.innerHTML =
      '<button type="button" class="done-group-toggle" data-action="toggle-done-group">' +
      (expanded ? "▲" : "▼") +
      " 완료한 장소 (" +
      doneItems.length +
      ")</button>" +
      (expanded
        ? '<div class="done-group-list">' +
          doneItems
            .map(
              (p) =>
                '<div class="done-group-row"><span class="done-group-name">✓ ' +
                escapeHtml(formatPlaceName(p)) +
                '</span><button type="button" class="done-group-undo" data-action="toggle-done" data-place-id="' +
                p.id +
                '">완료 해제</button></div>'
            )
            .join("") +
          "</div>"
        : "");
  }

  // 요일별 영업시간(있는 매장만) 기준으로 지금 영업중인지 계산 — 기기 시각을
  // 그대로 쓰므로, 실제 도쿄 현지에서 사용할 때는 별도 타임존 변환이 필요 없다.
  function toMinutes(hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  }

  function minutesLabel(mins) {
    return mins >= 60 ? Math.floor(mins / 60) + "시간" + (mins % 60 ? " " + (mins % 60) + "분" : "") : mins + "분";
  }

  // 일부 식당은 브레이크타임(예: 15:00~17:00 사이 재료 준비로 휴식)이 있어
  // open~close 사이라도 실제로는 문을 닫는 시간대가 있다 — 요일별 hours에
  // breakStart/breakEnd가 있으면 이를 반영한다.
  function getOpenStatus(hours) {
    if (!hours) return null;
    const now = new Date();
    const today = hours[now.getDay()];
    const range = today ? today.open + "~" + today.close : "";
    if (!today) return { open: false, label: "정기휴무", range: "" };

    const nowMin = now.getHours() * 60 + now.getMinutes();
    const openMin = toMinutes(today.open);
    const closeMin = toMinutes(today.close);

    if (nowMin < openMin) return { open: false, label: today.open + "에 영업 시작", range: range };
    if (nowMin >= closeMin) return { open: false, label: "영업 종료", range: range };

    if (today.breakStart && today.breakEnd) {
      const breakStartMin = toMinutes(today.breakStart);
      const breakEndMin = toMinutes(today.breakEnd);
      if (nowMin >= breakStartMin && nowMin < breakEndMin) {
        return { open: false, label: "브레이크타임 · " + today.breakEnd + "에 재개", range: range };
      }
      if (nowMin < breakStartMin) {
        return { open: true, label: "브레이크타임까지 " + minutesLabel(breakStartMin - nowMin), range: range };
      }
    }

    return { open: true, label: "마감까지 " + minutesLabel(closeMin - nowMin), range: range };
  }

  function buildPlaceCard(place, day, idx) {
    const isDone = !!state.donePlaces[place.id];
    const colorKind = getColorKind(place);
    const card = document.createElement("article");
    card.className = "place-card " + colorKind + (isDone ? " is-done" : "");
    card.dataset.cardId = place.id;

    let relatedHtml = "";
    if (place.relatedBrands && place.relatedBrands.length) {
      relatedHtml =
        '<div class="related-brands"><p class="related-brands-title">여기서 찾아볼 브랜드</p>' +
        '<div class="related-brands-list">' +
        place.relatedBrands.map((b) => '<span class="related-brand-tag">✓ ' + escapeHtml(b) + "</span>").join("") +
        "</div></div>";
    }

    const nextPlace = day.places[idx + 1];
    let nextHtml;
    if (nextPlace && place.transportToNext) {
      const t = place.transportToNext;
      const modeClass = t.mode === "walk" ? "walk" : "taxi";
      const modeIcon = t.mode === "walk" ? "🚶" : "🚕";
      nextHtml =
        '<div class="card-next-place" data-next-id="' +
        nextPlace.id +
        '"><span class="arrow-down">↓</span><span class="transport-badge ' +
        modeClass +
        '">' +
        modeIcon +
        " " +
        t.time +
        '</span><span class="next-name">' +
        escapeHtml(nextPlace.name) +
        '</span><span class="chevron">›</span></div>';
    } else {
      nextHtml = '<div class="card-last-note">오늘의 마지막 장소입니다 🎉</div>';
    }

    const openStatus = getOpenStatus(place.hours);
    const hoursHtml = openStatus
      ? '<div class="hours-badge ' +
        (openStatus.open ? "open" : "closed") +
        '">' +
        (openStatus.open ? "🟢" : "🔴") +
        " " +
        escapeHtml(openStatus.label) +
        (openStatus.range ? " · " + escapeHtml(openStatus.range) : "") +
        "</div>"
      : "";

    const lat = place.coords[0];
    const lng = place.coords[1];
    const memoText = state.memos[place.id] || "";
    const memoExpanded = Object.prototype.hasOwnProperty.call(state.expandedMemos, place.id)
      ? state.expandedMemos[place.id]
      : !!memoText;
    const memoHtml =
      '<div class="card-memo-section">' +
      '<button type="button" class="card-section-toggle" data-action="toggle-memo" data-place-id="' +
      place.id +
      '">📝 메모' +
      (memoText ? "" : " 남기기") +
      "</button>" +
      '<textarea class="card-memo-textarea" data-place-id="' +
      place.id +
      '" placeholder="예) 셔츠 보기, 팬츠 보기, 재고 확인"' +
      (memoExpanded ? "" : " hidden") +
      ">" +
      escapeHtml(memoText) +
      "</textarea>" +
      "</div>";

    const purchases = state.purchases[place.id] || [];
    const purchaseListHtml = purchases
      .map(
        (entry) =>
          '<div class="purchase-item"><span class="purchase-item-name">' +
          escapeHtml(entry.item) +
          (entry.size ? '<span class="purchase-item-size">' + escapeHtml(entry.size) + "</span>" : "") +
          '</span><span class="purchase-item-price">¥' +
          (entry.price || 0).toLocaleString() +
          '</span><button type="button" class="purchase-item-remove" data-action="delete-purchase" data-place-id="' +
          place.id +
          '" data-purchase-id="' +
          entry.id +
          '" aria-label="구매 기록 삭제">✕</button></div>'
      )
      .join("");
    const purchaseHtml =
      '<div class="card-purchase-section">' +
      '<div class="card-section-toggle-row">🛍️ 구매 기록' +
      (purchases.length ? " (" + purchases.length + ")" : "") +
      "</div>" +
      (purchaseListHtml ? '<div class="purchase-list">' + purchaseListHtml + "</div>" : "") +
      '<button type="button" class="card-add-purchase-btn" data-action="toggle-purchase-form" data-place-id="' +
      place.id +
      '">+ 구매 추가</button>' +
      '<div class="purchase-form" hidden>' +
      '<input type="text" class="purchase-item-input" placeholder="상품명" />' +
      '<input type="text" class="purchase-size-input" placeholder="사이즈(선택)" />' +
      '<input type="number" inputmode="numeric" class="purchase-price-input" placeholder="가격(¥)" />' +
      '<button type="button" class="btn btn-primary purchase-submit-btn" data-action="add-purchase" data-place-id="' +
      place.id +
      '">추가</button>' +
      "</div>" +
      "</div>";

    card.innerHTML =
      '<div class="place-card-head">' +
      '<span class="card-order-badge ' +
      colorKind +
      '">' +
      (idx + 1) +
      "</span>" +
      '<div class="place-card-title-group">' +
      '<p class="place-card-name">' +
      escapeHtml(formatPlaceName(place)) +
      (isDone ? '<span class="done-badge">완료</span>' : "") +
      "</p>" +
      '<p class="place-card-address">' +
      escapeHtml(place.address) +
      "</p>" +
      "</div>" +
      '<div class="place-card-head-right">' +
      (place.scheduledTime
        ? '<span class="time-badge">🕓 ' + escapeHtml(place.scheduledTime) + "</span>"
        : "") +
      '<span class="category-chip ' +
      colorKind +
      '">' +
      CATEGORY_LABEL[colorKind] +
      "</span>" +
      "</div>" +
      '<button type="button" class="card-remove-btn" data-action="remove-place" data-place-id="' +
      place.id +
      '" aria-label="일정에서 제외" title="일정에서 제외">✕</button>' +
      "</div>" +
      '<div class="card-reorder-row">' +
      '<button type="button" class="card-reorder-btn" data-action="move-place" data-place-id="' +
      place.id +
      '" data-direction="prev"' +
      (idx === 0 ? " disabled" : "") +
      ' aria-label="순서 앞으로">◀ 순서 변경</button>' +
      '<button type="button" class="card-reorder-btn" data-action="move-place" data-place-id="' +
      place.id +
      '" data-direction="next"' +
      (idx === day.places.length - 1 ? " disabled" : "") +
      ' aria-label="순서 뒤로">뒤로 ▶</button>' +
      "</div>" +
      '<div class="place-card-stars">' +
      renderStars(place.rating) +
      "</div>" +
      '<div class="place-card-meta">추천 체류 <strong>' +
      escapeHtml(place.recommendedDuration) +
      "</strong></div>" +
      hoursHtml +
      (place.note ? '<p class="place-card-note">' + escapeHtml(place.note) + "</p>" : "") +
      relatedHtml +
      '<div class="place-card-actions">' +
      '<a class="btn btn-icon" href="https://www.google.com/maps/dir/?api=1&destination=' +
      lat +
      "," +
      lng +
      '&travelmode=walking" target="_blank" rel="noopener" title="도보 길찾기">🚶</a>' +
      '<a class="btn btn-icon" href="https://www.google.com/maps/dir/?api=1&destination=' +
      lat +
      "," +
      lng +
      '&travelmode=driving" target="_blank" rel="noopener" title="택시 길찾기">🚕</a>' +
      '<button type="button" class="btn btn-primary" data-action="maps" data-query="' +
      encodeURIComponent(place.googleMapsQuery || place.name + " " + place.address) +
      '">📍 Maps</button>' +
      '<button type="button" class="btn btn-success' +
      (isDone ? " is-checked" : "") +
      '" data-action="toggle-done" data-place-id="' +
      place.id +
      '">' +
      (isDone ? "✓ 완료됨" : "체크 완료") +
      "</button>" +
      '<button type="button" class="btn btn-outline" data-action="next-card" data-idx="' +
      idx +
      '"' +
      (nextPlace ? "" : " disabled") +
      ">다음 ▶</button>" +
      "</div>" +
      nextHtml +
      memoHtml +
      purchaseHtml;

    const memoTextarea = card.querySelector(".card-memo-textarea");
    memoTextarea.addEventListener("change", () => {
      const val = memoTextarea.value;
      if (val.trim()) {
        state.memos[place.id] = val;
      } else {
        delete state.memos[place.id];
      }
      persistMemos();
    });

    return card;
  }

  // 편집숍처럼 여러 브랜드를 취급하는 곳은 "매장명 (브랜드1, 브랜드2)" 형태로 표기
  function formatPlaceName(place) {
    if (place.relatedBrands && place.relatedBrands.length) {
      return place.name + " (" + place.relatedBrands.join(", ") + ")";
    }
    return place.name;
  }

  function renderStars(rating) {
    const full = "★".repeat(rating);
    const empty = '<span class="star-empty">' + "★".repeat(5 - rating) + "</span>";
    return full + empty;
  }

  // ---------------------------------------------------------------------
  // Day banner — 항공편/체크인처럼 지도에 표시할 수 없는 정보를 텍스트로 안내
  // ---------------------------------------------------------------------
  function renderBanner(day) {
    if (!dom.dayBanner) return;
    if (!day.flightInfo) {
      dom.dayBanner.innerHTML = "";
      dom.dayBanner.style.display = "none";
      return;
    }
    dom.dayBanner.style.display = "block";
    dom.dayBanner.innerHTML = escapeHtml(day.flightInfo);
  }

  // ---------------------------------------------------------------------
  // Timeline
  // ---------------------------------------------------------------------
  const TIMELINE_COLLAPSE_THRESHOLD = 4;

  function renderTimeline(day) {
    const items = [{ type: "hotel", id: null, name: TRIP_DATA.meta.hotelName, transport: day.fromHotel, time: null }].concat(
      day.places.map((p) => ({
        type: getColorKind(p),
        id: p.id,
        name: formatPlaceName(p),
        transport: p.transportToNext,
        time: p.scheduledTime,
      }))
    );

    const canCollapse = day.places.length > TIMELINE_COLLAPSE_THRESHOLD;
    let visibleItems = items;
    let hiddenCount = 0;
    if (canCollapse && !state.timelineExpanded) {
      const current = getCurrentTarget(day).current;
      const currentIdx = current ? items.findIndex((it) => it.id === current.id) : 1;
      const start = Math.max(0, currentIdx - 1);
      const end = Math.min(items.length, start + 3);
      visibleItems = items.slice(start, end);
      hiddenCount = items.length - visibleItems.length;
    }

    dom.timeline.innerHTML = renderTimelineItems(visibleItems, items) + (canCollapse ? timelineToggleHtml(hiddenCount) : "");
  }

  function timelineToggleHtml(hiddenCount) {
    return (
      '<button type="button" class="timeline-toggle" data-action="toggle-timeline">' +
      (state.timelineExpanded ? "▲ 접기" : "▼ 전체 일정 보기 (" + hiddenCount + "개 더 보기)") +
      "</button>"
    );
  }

  function renderTimelineItems(visibleItems, allItems) {
    return visibleItems
      .map((item) => {
        const idx = allItems.indexOf(item);
        const isLast = idx === allItems.length - 1;
        const dotClass = item.type === "hotel" ? "hotel" : item.type;
        const dotContent = item.type === "hotel" ? "🏨" : "";
        let transportHtml = "";
        if (!isLast && item.transport) {
          const t = item.transport;
          const modeClass = t.mode === "walk" ? "mode-walk" : "mode-taxi";
          const icon = t.mode === "walk" ? "🚶" : "🚕";
          const cost = t.cost ? " · ¥" + t.cost.toLocaleString() : "";
          transportHtml =
            '<div class="timeline-transport"><span class="' +
            modeClass +
            '">' +
            icon +
            " " +
            t.time +
            "</span>" +
            cost +
            "</div>";
        }
        return (
          '<div class="timeline-item">' +
          '<div class="timeline-marker-col">' +
          '<div class="timeline-dot ' +
          dotClass +
          '">' +
          dotContent +
          "</div>" +
          (!isLast ? '<div class="timeline-line"></div>' : "") +
          "</div>" +
          '<div class="timeline-content">' +
          '<p class="timeline-name">' +
          (item.time ? '<span class="timeline-time">' + escapeHtml(item.time) + "</span> " : "") +
          escapeHtml(item.name) +
          "</p>" +
          transportHtml +
          "</div>" +
          "</div>"
        );
      })
      .join("");
  }

  // ---------------------------------------------------------------------
  // Checklist
  // ---------------------------------------------------------------------
  function renderChecklist() {
    const brands = TRIP_DATA.checklistBrands;
    const doneCount = brands.filter((b) => state.checklist[b]).length;
    dom.checklistProgress.textContent = doneCount + " / " + brands.length;

    dom.checklist.innerHTML = brands
      .map((brand) => {
        const checked = !!state.checklist[brand];
        const place = findPlaceByNameCI(brand);
        const dayLabel = place ? findDayLabelForPlace(place.id) : "";
        return (
          '<div class="checklist-item' +
          (checked ? " checked" : "") +
          '" data-brand="' +
          escapeHtml(brand) +
          '">' +
          '<span class="checkbox' +
          (checked ? " checked" : "") +
          '"></span>' +
          '<span class="checklist-item-label">' +
          escapeHtml(brand) +
          "</span>" +
          (dayLabel ? '<span class="checklist-item-day">' + dayLabel + "</span>" : "") +
          "</div>"
        );
      })
      .join("");
  }

  function findDayLabelForPlace(placeId) {
    const day = getAllEffectiveDays().find((d) => d.places.some((p) => p.id === placeId));
    return day ? formatMonthDay(day.date) : "";
  }

  // ---------------------------------------------------------------------
  // Budget — 쇼핑 / 택시 / 식비를 데이터에서 자동 합산
  // ---------------------------------------------------------------------
  function computeBudget(days) {
    let shopping = 0;
    let taxi = 0;
    let food = 0;

    days.forEach((day) => {
      if (day.fromHotel && day.fromHotel.mode === "taxi") taxi += day.fromHotel.cost || 0;
      day.places.forEach((p) => {
        if (p.costCategory === "shopping") shopping += p.cost || 0;
        if (p.costCategory === "food") food += p.cost || 0;
        if (p.transportToNext && p.transportToNext.mode === "taxi") {
          taxi += p.transportToNext.cost || 0;
        }
      });
    });

    return { shopping: shopping, taxi: taxi, food: food, total: shopping + taxi + food };
  }

  // 실제 구매기록(4번) 합계 — "예정 지출"(computeBudget, 데이터에 미리 적힌 예상치)과는
  // 별개로 여행 중 실제로 쓴 돈을 추적한다. 5번/12번이 이 값을 공유해서 쓴다.
  function computeSpentAmount() {
    let total = 0;
    Object.keys(state.purchases).forEach((placeId) => {
      (state.purchases[placeId] || []).forEach((entry) => {
        total += entry.price || 0;
      });
    });
    return total;
  }

  function getShoppingBudgetStatus() {
    const spent = computeSpentAmount();
    const limit = state.budgetLimit;
    return { limit: limit, spent: spent, remaining: limit != null ? limit - spent : null };
  }

  function formatYen(n) {
    return (n < 0 ? "-¥" : "¥") + Math.abs(n).toLocaleString();
  }

  function renderBudget() {
    const day = getEffectiveDay(state.dayIndex);
    const budget = computeBudget(state.budgetTab === "today" ? [day] : getAllEffectiveDays());
    const status = getShoppingBudgetStatus();

    dom.budgetCard.innerHTML =
      '<div class="budget-tabs">' +
      '<button type="button" class="budget-tab' +
      (state.budgetTab === "today" ? " active" : "") +
      '" data-budget-tab="today">오늘 (' +
      formatMonthDay(day.date) +
      ")</button>" +
      '<button type="button" class="budget-tab' +
      (state.budgetTab === "trip" ? " active" : "") +
      '" data-budget-tab="trip">전체 여행</button>' +
      "</div>" +
      budgetRow("shopping", "🛍️", "쇼핑 (예정)", budget.shopping) +
      budgetRow("taxi", "🚕", "택시 (예정)", budget.taxi) +
      budgetRow("food", "🍽️", "식비 (예정)", budget.food) +
      '<div class="budget-total-row"><span class="budget-total-label">예정 지출 총합</span>' +
      '<span class="budget-total-value">¥' +
      budget.total.toLocaleString() +
      "</span></div>" +
      '<div class="shopping-budget-section">' +
      '<div class="shopping-budget-header">💰 내 쇼핑 예산 (실제 구매 기준)</div>' +
      '<div class="shopping-budget-input-row">' +
      '<span class="shopping-budget-input-label">총 예산</span>' +
      '<div class="shopping-budget-input-field"><span>¥</span><input type="number" inputmode="numeric" min="0" id="budgetLimitInput" placeholder="예: 200000" value="' +
      (status.limit != null ? status.limit : "") +
      '" /></div>' +
      "</div>" +
      '<div class="shopping-budget-stats">' +
      '<div class="shopping-budget-stat"><span class="shopping-budget-stat-label">사용</span><span class="shopping-budget-stat-value">¥' +
      status.spent.toLocaleString() +
      "</span></div>" +
      '<div class="shopping-budget-stat"><span class="shopping-budget-stat-label">남음</span><span class="shopping-budget-stat-value' +
      (status.remaining != null && status.remaining < 0 ? " over" : "") +
      '">' +
      (status.remaining != null ? formatYen(status.remaining) : "—") +
      "</span></div>" +
      "</div>" +
      "</div>";

    const limitInput = dom.budgetCard.querySelector("#budgetLimitInput");
    if (limitInput) {
      limitInput.addEventListener("change", () => {
        const v = parseInt(limitInput.value, 10);
        state.budgetLimit = isNaN(v) || v <= 0 ? null : v;
        persistBudgetLimit();
        renderBudget();
        renderTripSummary();
      });
    }
  }

  function budgetRow(type, icon, label, value) {
    return (
      '<div class="budget-row"><span class="budget-label"><span class="budget-icon ' +
      type +
      '">' +
      icon +
      "</span>" +
      label +
      '</span><span class="budget-value">¥' +
      value.toLocaleString() +
      "</span></div>"
    );
  }

  // ---------------------------------------------------------------------
  // 여행 요약 대시보드 — 날짜와 무관하게 여행 전체 기준으로 상단에 항상 노출
  // ---------------------------------------------------------------------
  function computeTripSummary() {
    const days = getAllEffectiveDays();
    let totalPlaces = 0;
    let doneCount = 0;
    let totalMinutes = 0;

    days.forEach((day) => {
      if (day.fromHotel) totalMinutes += parseMinutes(day.fromHotel.time);
      day.places.forEach((p) => {
        totalPlaces += 1;
        if (state.donePlaces[p.id]) doneCount += 1;
        if (p.transportToNext) totalMinutes += parseMinutes(p.transportToNext.time);
      });
    });

    const budget = computeBudget(days);
    return {
      totalPlaces: totalPlaces,
      doneCount: doneCount,
      totalMinutes: totalMinutes,
      taxiCost: budget.taxi,
      shoppingStatus: getShoppingBudgetStatus(),
    };
  }

  function formatMinutesAsHM(minutes) {
    if (minutes < 60) return minutes + "분";
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h + "시간" + (m > 0 ? " " + m + "분" : "");
  }

  function renderTripSummary() {
    if (!dom.tripSummary) return;
    const s = computeTripSummary();
    dom.tripSummary.innerHTML =
      tripSummaryItem(s.doneCount + " / " + s.totalPlaces, "방문 완료") +
      tripSummaryItem(formatMinutesAsHM(s.totalMinutes), "총 이동시간") +
      tripSummaryItem("¥" + s.taxiCost.toLocaleString(), "예상 택시비") +
      tripSummaryItem(s.shoppingStatus.remaining != null ? formatYen(s.shoppingStatus.remaining) : "—", "남은 예산");
  }

  function tripSummaryItem(value, label) {
    return (
      '<div class="trip-summary-item"><span class="trip-summary-value">' +
      value +
      '</span><span class="trip-summary-label">' +
      label +
      "</span></div>"
    );
  }

  // ---------------------------------------------------------------------
  // Data lookup helpers (전체 TRIP_DATA 기준 — 체크리스트는 날짜 무관하게 전역)
  // ---------------------------------------------------------------------
  function findPlaceById(placeId) {
    for (const day of getAllEffectiveDays()) {
      const p = day.places.find((pl) => pl.id === placeId);
      if (p) return p;
    }
    return null;
  }

  function findPlaceByNameCI(name) {
    const lower = name.toLowerCase();
    for (const day of getAllEffectiveDays()) {
      const p = day.places.find((pl) => pl.name.toLowerCase() === lower);
      if (p) return p;
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Actions — 카드 체크, 브랜드 체크리스트는 서로 자동 동기화된다
  // ---------------------------------------------------------------------
  function toggleDonePlace(placeId) {
    const newVal = !state.donePlaces[placeId];
    state.donePlaces[placeId] = newVal;
    persistDonePlaces();

    const place = findPlaceById(placeId);
    if (place) {
      const brand = TRIP_DATA.checklistBrands.find((b) => b.toLowerCase() === place.name.toLowerCase());
      if (brand) {
        state.checklist[brand] = newVal;
        persistChecklist();
      }
      showToast(newVal ? place.name + " 체크 완료!" : place.name + " 체크 해제됨");
    }

    renderCards(getEffectiveDay(state.dayIndex));
    updateMapDoneStates();
    renderChecklist();
    renderNowCard(getEffectiveDay(state.dayIndex));
    renderTripSummary();
  }

  function toggleChecklistBrand(brand) {
    const newVal = !state.checklist[brand];
    state.checklist[brand] = newVal;
    persistChecklist();

    const place = findPlaceByNameCI(brand);
    if (place) {
      state.donePlaces[place.id] = newVal;
      persistDonePlaces();
    }

    renderChecklist();
    const currentDay = getEffectiveDay(state.dayIndex);
    if (place && currentDay.places.some((p) => p.id === place.id)) {
      renderCards(currentDay);
    }
    updateMapDoneStates();
  }

  // ---------------------------------------------------------------------
  // Global event delegation
  // ---------------------------------------------------------------------
  function bindGlobalEvents() {
    if (dom.addPlaceBtn) {
      dom.addPlaceBtn.addEventListener("click", openAddPlaceModal);
    }

    document.addEventListener("click", (e) => {
      const actionBtn = e.target.closest("[data-action]");
      if (actionBtn) {
        if (actionBtn.classList.contains("btn")) addRipple(actionBtn, e);
        handleAction(actionBtn);
        return;
      }

      const budgetTabBtn = e.target.closest("[data-budget-tab]");
      if (budgetTabBtn) {
        state.budgetTab = budgetTabBtn.dataset.budgetTab;
        renderBudget();
        return;
      }

      const nextRow = e.target.closest(".card-next-place");
      if (nextRow) {
        goToPlace(nextRow.dataset.nextId);
        return;
      }

      const checklistItem = e.target.closest(".checklist-item");
      if (checklistItem) {
        toggleChecklistBrand(checklistItem.dataset.brand);
      }
    });
  }

  function handleAction(btn) {
    const action = btn.dataset.action;

    if (action === "maps") {
      // 좌표가 아니라 "정식 매장명 + 실주소"로 검색시켜, 실제 구글맵상의 정확한
      // 매장 위치(리뷰/영업시간 포함)로 연결되게 한다.
      const url = "https://www.google.com/maps/search/?api=1&query=" + btn.dataset.query;
      window.open(url, "_blank", "noopener");
      return;
    }

    if (action === "toggle-done") {
      toggleDonePlace(btn.dataset.placeId);
      return;
    }

    if (action === "remove-place") {
      removePlaceFromDay(state.dayIndex, btn.dataset.placeId);
      return;
    }

    if (action === "next-card") {
      const day = getEffectiveDay(state.dayIndex);
      const idx = Number(btn.dataset.idx);
      const next = day.places[idx + 1];
      if (next) goToPlace(next.id);
      return;
    }

    if (action === "move-place") {
      movePlaceInDay(state.dayIndex, btn.dataset.placeId, btn.dataset.direction);
      return;
    }

    if (action === "toggle-done-group") {
      state.doneGroupExpanded = !state.doneGroupExpanded;
      renderDoneGroup(getEffectiveDay(state.dayIndex));
      return;
    }

    if (action === "toggle-timeline") {
      state.timelineExpanded = !state.timelineExpanded;
      renderTimeline(getEffectiveDay(state.dayIndex));
      return;
    }

    if (action === "toggle-memo") {
      const placeId = btn.dataset.placeId;
      state.expandedMemos[placeId] = !state.expandedMemos[placeId];
      renderCards(getEffectiveDay(state.dayIndex));
      return;
    }

    if (action === "toggle-purchase-form") {
      const form = btn.parentElement.querySelector(".purchase-form");
      if (form) form.hidden = !form.hidden;
      return;
    }

    if (action === "add-purchase") {
      addPurchaseFromForm(btn);
      return;
    }

    if (action === "delete-purchase") {
      const placeId = btn.dataset.placeId;
      const purchaseId = btn.dataset.purchaseId;
      state.purchases[placeId] = (state.purchases[placeId] || []).filter((e) => e.id !== purchaseId);
      persistPurchases();
      renderCards(getEffectiveDay(state.dayIndex));
      renderBudget();
      renderTripSummary();
      return;
    }
  }

  function movePlaceInDay(dayIndex, placeId, direction) {
    applyDayOrderChange(dayIndex, (order) => {
      const idx = order.indexOf(placeId);
      const targetIdx = direction === "prev" ? idx - 1 : idx + 1;
      if (idx === -1 || targetIdx < 0 || targetIdx >= order.length) return order;
      const next = order.slice();
      const tmp = next[idx];
      next[idx] = next[targetIdx];
      next[targetIdx] = tmp;
      return next;
    });
  }

  function addPurchaseFromForm(btn) {
    const section = btn.closest(".card-purchase-section");
    const placeId = btn.dataset.placeId;
    const itemInput = section.querySelector(".purchase-item-input");
    const sizeInput = section.querySelector(".purchase-size-input");
    const priceInput = section.querySelector(".purchase-price-input");
    const item = itemInput.value.trim();
    if (!item) {
      showToast("상품명을 입력해주세요");
      return;
    }
    const price = parseInt(priceInput.value, 10);
    const entry = {
      id: "purchase-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      item: item,
      price: isNaN(price) ? 0 : price,
      size: sizeInput.value.trim(),
    };
    state.purchases[placeId] = (state.purchases[placeId] || []).concat(entry);
    persistPurchases();
    renderCards(getEffectiveDay(state.dayIndex));
    renderBudget();
    renderTripSummary();
    showToast(item + " 구매 기록 추가됨");
  }

  // ---------------------------------------------------------------------
  // UI utilities
  // ---------------------------------------------------------------------
  function addRipple(el, event) {
    const rect = el.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const span = document.createElement("span");
    span.className = "ripple";
    const clientX = typeof event.clientX === "number" && event.clientX !== 0 ? event.clientX : rect.left + rect.width / 2;
    const clientY = typeof event.clientY === "number" && event.clientY !== 0 ? event.clientY : rect.top + rect.height / 2;
    span.style.width = span.style.height = size + "px";
    span.style.left = clientX - rect.left - size / 2 + "px";
    span.style.top = clientY - rect.top - size / 2 + "px";
    el.appendChild(span);
    setTimeout(() => span.remove(), 500);
  }

  function showToast(msg, action) {
    dom.toast.innerHTML = "";
    const msgSpan = document.createElement("span");
    msgSpan.textContent = msg;
    dom.toast.appendChild(msgSpan);
    if (action) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "toast-undo-btn";
      btn.textContent = action.label;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        clearTimeout(toastTimer);
        dom.toast.classList.remove("show");
        action.onClick();
      });
      dom.toast.appendChild(btn);
    }
    dom.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => dom.toast.classList.remove("show"), action ? 4000 : 1800);
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = String(str);
    return div.innerHTML;
  }
})();
