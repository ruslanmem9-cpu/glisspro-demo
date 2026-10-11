/*
 * GlissPro demo: корзина, скидка на первый заказ, сравнение, оформление,
 * имитация статусов оплаты и данные для amoCRM. Без сервера: всё в localStorage.
 * Боевая версия: логику оплаты и CRM переносим на Tilda + webhook (см. docs/otklik.md).
 */
(function () {
  "use strict";

  var KEYS = {
    cart: "gp_cart",
    compare: "gp_compare",
    customers: "gp_customers",
    orders: "gp_orders"
  };
  var FIRST_ORDER_PERCENT = 10;
  var COMPARE_LIMIT = 3;
  var PICKUP_POINTS = [
    "Санкт-Петербург, пункт выдачи 1 (адрес уточняется)",
    "Санкт-Петербург, пункт выдачи 2 (адрес уточняется)"
  ];
  var STATUS_TEXT = {
    awaiting_payment: "Ожидает оплаты",
    awaiting_invoice: "Ожидает счёт от менеджера",
    paid: "Оплачен",
    failed: "Оплата не прошла",
    canceled: "Отменён"
  };
  var NAV = [
    ["catalog.html", "catalog", "Каталог"],
    ["delivery.html", "delivery", "Доставка и оплата"],
    ["returns.html", "returns", "Поддержка и возврат"],
    ["partners.html", "partners", "Партнёрам"],
    ["about.html", "about", "О компании"],
    ["contacts.html", "contacts", "Контакты"]
  ];

  var products = window.GP_PRODUCTS || [];
  var categories = window.GP_CATEGORIES || {};

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function read(key, fallback) {
    try {
      var v = JSON.parse(localStorage.getItem(key));
      return v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }
  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage disabled */ }
  }
  function money(n) { return new Intl.NumberFormat("ru-RU").format(Math.round(n)) + " ₽"; }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function productById(id) {
    for (var i = 0; i < products.length; i++) if (products[i].id === id) return products[i];
    return null;
  }
  function minPrice(p) {
    return Math.min.apply(null, p.variants.map(function (v) { return v.price; }));
  }
  function clampQty(n) {
    if (isNaN(n)) return 1;
    return Math.max(1, Math.min(99, n));
  }

  // События для Яндекс Метрики и GA. Цели в Метрике заводит заказчик.
  function track(event, params) {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(Object.assign({ event: event }, params || {}));
  }

  function showToast(msg) {
    var t = $("#toast");
    if (!t) return;
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(function () { t.hidden = true; }, 2200);
  }

  /* ---------- Cart ---------- */
  function getCart() { return read(KEYS.cart, []); }
  function saveCart(items) { write(KEYS.cart, items); renderCounts(true); }

  function cartLines() {
    var lines = [];
    getCart().forEach(function (line, index) {
      var p = productById(line.id);
      if (!p) return;
      var variant = p.variants[line.variant] || p.variants[0];
      lines.push({
        index: index,
        product: p,
        variant: variant,
        qty: line.qty,
        lineTotal: variant.price * line.qty
      });
    });
    return lines;
  }

  function addToCart(id, variantIndex, qty) {
    var cart = getCart();
    var found = null;
    cart.forEach(function (l) {
      if (l.id === id && l.variant === variantIndex) found = l;
    });
    if (found) found.qty += qty;
    else cart.push({ id: id, variant: variantIndex, qty: qty });
    saveCart(cart);
    var p = productById(id);
    if (p) track("add_to_cart", { item_id: p.sku, variant: p.variants[variantIndex].label, qty: qty });
  }

  function setQty(index, qty) {
    var cart = getCart();
    if (!cart[index]) return;
    if (qty < 1) cart.splice(index, 1);
    else cart[index].qty = qty;
    saveCart(cart);
  }

  function subtotalOf(lines) {
    return lines.reduce(function (sum, l) { return sum + l.lineTotal; }, 0);
  }

  function totalsFor(lines, firstOrder) {
    var sub = subtotalOf(lines);
    var discount = firstOrder === true ? Math.round(sub * FIRST_ORDER_PERCENT / 100) : 0;
    return { subtotal: sub, discount: discount, delivery: 0, total: sub - discount };
  }

  /* ---------- Customers / first order ---------- */
  function customerKeys(contact) {
    var keys = [];
    var phone = (contact.phone || "").replace(/\D/g, "").replace(/^8/, "7");
    if (phone.length >= 10) keys.push("tel:" + phone);
    var email = (contact.email || "").trim().toLowerCase();
    if (email) keys.push("mail:" + email);
    return keys;
  }
  // true — первый заказ, false — уже был, null — контакта нет
  function firstOrderState(contact) {
    var keys = customerKeys(contact);
    if (!keys.length) return null;
    var known = read(KEYS.customers, []);
    for (var i = 0; i < keys.length; i++) {
      if (known.indexOf(keys[i]) !== -1) return false;
    }
    return true;
  }
  function rememberCustomer(contact) {
    var known = read(KEYS.customers, []);
    customerKeys(contact).forEach(function (k) {
      if (known.indexOf(k) === -1) known.push(k);
    });
    write(KEYS.customers, known);
  }

  /* ---------- Compare ---------- */
  function getCompare() { return read(KEYS.compare, []); }

  function toggleCompare(id) {
    var list = getCompare();
    var i = list.indexOf(id);
    if (i !== -1) {
      list.splice(i, 1);
      showToast("Убрано из сравнения");
    } else if (list.length >= COMPARE_LIMIT) {
      showToast("В сравнении может быть до " + COMPARE_LIMIT + " товаров");
      return;
    } else {
      list.push(id);
      showToast("Добавлено в сравнение");
    }
    write(KEYS.compare, list);
    renderCounts(false);
    syncCompareButtons();
  }

  function syncCompareButtons() {
    var list = getCompare();
    $$("[data-compare]").forEach(function (b) {
      var on = list.indexOf(b.getAttribute("data-compare")) !== -1;
      b.setAttribute("aria-pressed", String(on));
      b.textContent = on ? "В сравнении" : "Сравнить";
    });
  }

  /* ---------- Chrome (header, footer, counters) ---------- */
  function renderChrome() {
    var page = document.body.getAttribute("data-page") || "";
    var header = $("#site-header");
    if (header) {
      var links = NAV.map(function (n) {
        return '<a href="' + n[0] + '"' + (n[1] === page ? ' aria-current="page"' : "") + ">" + n[2] + "</a>";
      }).join("");
      header.innerHTML =
        '<header class="site-header"><div class="container site-header__inner">' +
        '<a class="brand" href="index.html">GLISS PRO</a>' +
        '<button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav">Меню</button>' +
        '<nav class="nav" id="site-nav" aria-label="Основная навигация">' + links + "</nav>" +
        '<div class="header-actions">' +
        '<a class="link-count" href="compare.html">Сравнение <span class="compare-count" data-count="compare">0</span></a>' +
        '<a class="btn btn--small" href="cart.html">Корзина <span class="cart-count" data-count="cart">0</span></a>' +
        "</div></div></header>";
    }
    var footer = $("#site-footer");
    if (footer) {
      footer.innerHTML =
        '<footer class="site-footer"><div class="container">' +
        '<div class="footer-grid">' +
        "<div>" +
        '<a class="brand" href="index.html">GLISS PRO</a>' +
        '<p style="margin-top:12px">Защитные покрытия, полироли и плёнки PPF для автомобилей. Санкт-Петербург.</p>' +
        '<p><a href="tel:+79213351891">+7 (921) 335-18-91</a><br>Звонки с 9:00 до 20:00 по Москве</p>' +
        "</div>" +
        '<nav aria-label="Разделы сайта">' + links + "</nav>" +
        '<div><p>Покупателям</p><p>Оферта и политика обработки данных: текст предоставит заказчик.</p></div>' +
        "</div>" +
        '<p class="footer-note">Демонстрационная версия. Товары, цены и тексты условные. Оплата и CRM имитируются.<br>' +
        '<button class="footer-reset" type="button" data-reset-demo>Сбросить демо-данные</button></p>' +
        "</div></footer>";
    }
    if (!$("#toast")) {
      var t = document.createElement("div");
      t.id = "toast";
      t.className = "toast";
      t.setAttribute("role", "status");
      t.setAttribute("aria-live", "polite");
      t.hidden = true;
      document.body.appendChild(t);
    }
  }

  function renderCounts(bump) {
    var cartCount = getCart().reduce(function (s, l) { return s + l.qty; }, 0);
    $$('[data-count="cart"]').forEach(function (el) {
      el.textContent = cartCount;
      if (bump) {
        el.classList.remove("is-bumped");
        void el.offsetWidth;
        el.classList.add("is-bumped");
      }
    });
    var compareCount = getCompare().length;
    $$('[data-count="compare"]').forEach(function (el) { el.textContent = compareCount; });
  }

  /* ---------- Catalog ---------- */
  function cardHtml(p) {
    var multi = p.variants.length > 1;
    var minPrice = Math.min.apply(null, p.variants.map(function (v) { return v.price; }));
    var action = multi
      ? '<a class="btn btn--small btn--ghost" href="product.html?id=' + p.id + '">Выбрать вариант</a>'
      : '<button class="btn btn--small" type="button" data-add="' + p.id + '">В корзину</button>';
    return (
      '<article class="product">' +
      '<a class="product__art" href="product.html?id=' + p.id + '" aria-label="' + esc(p.name) + '">Фото товара</a>' +
      '<span class="product__cat">' + esc(categories[p.category] || "") + "</span>" +
      '<h3 class="product__name"><a href="product.html?id=' + p.id + '" style="text-decoration:none">' + esc(p.name) + "</a></h3>" +
      '<p class="product__short">' + esc(p.short) + "</p>" +
      '<p class="product__price">' + (multi ? "от " : "") + money(minPrice) + "</p>" +
      '<div class="product__actions">' + action +
      '<button class="btn btn--ghost btn--small toggle-compare" type="button" data-compare="' + p.id + '" aria-pressed="false">Сравнить</button>' +
      "</div></article>"
    );
  }

  function initCatalog() {
    var grid = $("#product-grid");
    if (!grid) return;
    var chips = $("#category-chips");
    var search = $("#search");
    var count = $("#count");
    var sortEl = $("#sort");
    var state = { cat: "all", q: "", sort: "default" };

    sortEl.addEventListener("change", function () {
      state.sort = sortEl.value;
      render();
    });

    chips.innerHTML =
      '<button class="chip" type="button" data-cat="all" aria-pressed="true">Все</button>' +
      Object.keys(categories).map(function (k) {
        return '<button class="chip" type="button" data-cat="' + k + '" aria-pressed="false">' + esc(categories[k]) + "</button>";
      }).join("");

    chips.addEventListener("click", function (e) {
      var b = e.target.closest("[data-cat]");
      if (!b) return;
      state.cat = b.getAttribute("data-cat");
      $$("[data-cat]", chips).forEach(function (c) { c.setAttribute("aria-pressed", String(c === b)); });
      render();
    });
    search.addEventListener("input", function () {
      state.q = search.value.trim().toLowerCase();
      render();
    });

    function render() {
      var list = products.filter(function (p) {
        var okCat = state.cat === "all" || p.category === state.cat;
        var haystack = (p.name + " " + p.sku + " " + p.short).toLowerCase();
        var okQ = !state.q || haystack.indexOf(state.q) !== -1;
        return okCat && okQ;
      });
      if (state.sort === "price-asc") list.sort(function (a, b) { return minPrice(a) - minPrice(b); });
      if (state.sort === "price-desc") list.sort(function (a, b) { return minPrice(b) - minPrice(a); });
      if (state.sort === "name") list.sort(function (a, b) { return a.name.localeCompare(b.name, "ru"); });
      count.textContent = "Показано: " + list.length + " из " + products.length + " (демо-выборка из 104)";
      grid.innerHTML = list.map(cardHtml).join("") || '<p class="empty">Ничего не найдено. Попробуйте другой запрос.</p>';
      syncCompareButtons();
    }
    render();
  }

  /* ---------- Product page ---------- */
  function initProduct() {
    var root = $("#product-root");
    if (!root) return;
    var id = new URLSearchParams(window.location.search).get("id");
    var p = productById(id);
    if (!p) {
      root.innerHTML = '<p class="notice notice--warn">Товар не найден. <a href="catalog.html">Вернуться в каталог</a></p>';
      return;
    }
    document.title = p.name + " — GlissPro (демо)";
    var crumb = $("#crumb-name");
    if (crumb) crumb.textContent = p.name;
    var question = $("#question-product");
    if (question) question.value = p.sku + " — " + p.name;

    var multi = p.variants.length > 1;
    var variantsHtml = multi
      ? '<fieldset class="field" style="border:0;padding:0;margin:0 0 14px"><legend class="field__label" style="margin-bottom:8px">Вариант</legend><div class="choice-group">' +
        p.variants.map(function (v, i) {
          return '<label class="choice"><input type="radio" name="variant" value="' + i + '"' + (i === 0 ? " checked" : "") +
            "><span>" + esc(v.label) + " — " + money(v.price) + "</span></label>";
        }).join("") + "</div></fieldset>"
      : '<input type="hidden" name="variant" value="0">';

    root.innerHTML =
      '<div class="product-view">' +
      '<div class="product__art">Фото товара</div>' +
      "<div>" +
      '<p class="product__cat">' + esc(categories[p.category] || "") + " · арт. " + esc(p.sku) + "</p>" +
      '<h1 class="page-title" style="margin-top:6px">' + esc(p.name) + "</h1>" +
      '<p class="lede">' + esc(p.short) + "</p>" +
      '<div class="price-big" id="price">' + money(p.variants[0].price) + "</div>" +
      '<ul class="perks">' +
      "<li>Доставка за счёт GlissPro: 0 ₽ для покупателя</li>" +
      "<li>Скидка 10% на первый заказ при оформлении</li>" +
      "<li>Самовывоз, курьер по Санкт-Петербургу или транспортная компания</li>" +
      "</ul>" +
      '<form id="buy-form">' + variantsHtml +
      '<div class="buy-row">' +
      '<div class="qty"><button type="button" data-step="-1" aria-label="Меньше">−</button>' +
      '<input id="qty" type="number" min="1" max="99" value="1" aria-label="Количество">' +
      '<button type="button" data-step="1" aria-label="Больше">+</button></div>' +
      '<button class="btn" type="submit">В корзину</button>' +
      '<button class="btn btn--ghost toggle-compare" type="button" data-compare="' + p.id + '" aria-pressed="false">Сравнить</button>' +
      "</div>" +
      '<p class="notice notice--ok" id="buy-ok" hidden>Добавлено в корзину. <a href="cart.html">Перейти в корзину</a></p>' +
      "</form>" +
      '<table class="specs"><tbody>' +
      Object.keys(p.specs).map(function (k) {
        return "<tr><th>" + esc(k) + "</th><td>" + esc(p.specs[k]) + "</td></tr>";
      }).join("") +
      "</tbody></table>" +
      "</div></div>";

    var form = $("#buy-form");
    var qtyEl = $("#qty");
    var priceEl = $("#price");
    var okEl = $("#buy-ok");

    function currentVariant() { return parseInt(form.elements.variant.value, 10) || 0; }

    form.addEventListener("change", function () {
      priceEl.textContent = money(p.variants[currentVariant()].price);
      okEl.hidden = true;
    });
    $$("[data-step]", form).forEach(function (b) {
      b.addEventListener("click", function () {
        qtyEl.value = clampQty(parseInt(qtyEl.value, 10) + parseInt(b.getAttribute("data-step"), 10));
      });
    });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      addToCart(p.id, currentVariant(), clampQty(parseInt(qtyEl.value, 10)));
      okEl.hidden = false;
      showToast("Добавлено в корзину");
    });
    syncCompareButtons();
  }

  /* ---------- Compare page ---------- */
  function initCompare() {
    var box = $("#compare-root");
    if (!box) return;

    function render() {
      var ps = getCompare().map(productById).filter(Boolean);
      if (!ps.length) {
        box.innerHTML = '<p class="empty">В сравнении пока ничего нет. <a href="catalog.html">Выбрать в каталоге</a> (до ' + COMPARE_LIMIT + ' товаров).</p>';
        return;
      }
      var keys = [];
      ps.forEach(function (p) {
        Object.keys(p.specs).forEach(function (k) { if (keys.indexOf(k) === -1) keys.push(k); });
      });
      var head = "<tr><th></th>" + ps.map(function (p) {
        return '<th><a href="product.html?id=' + p.id + '">' + esc(p.name) + "</a><br>" +
          '<button class="link-button" type="button" data-remove="' + p.id + '">Убрать</button></th>';
      }).join("") + "</tr>";
      var priceRow = "<tr><th>Цена от</th>" + ps.map(function (p) {
        return "<td>" + money(Math.min.apply(null, p.variants.map(function (v) { return v.price; }))) + "</td>";
      }).join("") + "</tr>";
      var rows = keys.map(function (k) {
        return "<tr><th>" + esc(k) + "</th>" + ps.map(function (p) {
          return "<td>" + esc(p.specs[k] || "—") + "</td>";
        }).join("") + "</tr>";
      }).join("");
      var buyRow = "<tr><th>Заказ</th>" + ps.map(function (p) {
        return "<td>" + (p.variants.length > 1
          ? '<a class="btn btn--small btn--ghost" href="product.html?id=' + p.id + '">Выбрать вариант</a>'
          : '<button class="btn btn--small" type="button" data-add="' + p.id + '">В корзину</button>') + "</td>";
      }).join("") + "</tr>";

      box.innerHTML = '<div class="compare-wrap"><table class="compare"><thead>' + head + "</thead><tbody>" +
        priceRow + rows + buyRow + "</tbody></table></div>";
    }

    box.addEventListener("click", function (e) {
      var r = e.target.closest("[data-remove]");
      if (!r) return;
      var id = r.getAttribute("data-remove");
      write(KEYS.compare, getCompare().filter(function (x) { return x !== id; }));
      renderCounts(false);
      render();
    });
    render();
  }

  /* ---------- Cart page ---------- */
  function lineHtml(l) {
    return '<div class="cart-line">' +
      '<div class="cart-line__art"></div>' +
      "<div>" +
      '<p class="cart-line__name"><a href="product.html?id=' + l.product.id + '">' + esc(l.product.name) + "</a></p>" +
      '<p class="cart-line__meta">' + esc(l.variant.label) + " · " + money(l.variant.price) + "</p>" +
      '<div class="qty">' +
      '<button type="button" data-line="' + l.index + '" data-act="dec" aria-label="Уменьшить">−</button>' +
      '<input data-qty="' + l.index + '" type="number" min="1" max="99" value="' + l.qty + '" aria-label="Количество">' +
      '<button type="button" data-line="' + l.index + '" data-act="inc" aria-label="Увеличить">+</button>' +
      "</div></div>" +
      '<div class="cart-line__side"><strong>' + money(l.lineTotal) + "</strong>" +
      '<button class="link-button" type="button" data-line="' + l.index + '" data-act="remove">Удалить</button></div>' +
      "</div>";
  }

  function initCart() {
    var box = $("#cart-root");
    if (!box) return;

    function render() {
      var lines = cartLines();
      if (!lines.length) {
        box.innerHTML = '<div class="panel"><p>Корзина пока пуста.</p><a class="btn" href="catalog.html">Перейти в каталог</a></div>';
        return;
      }
      var t = totalsFor(lines, true);
      box.innerHTML =
        '<div class="two-col">' +
        '<div class="panel">' + lines.map(lineHtml).join("") + "</div>" +
        '<aside class="panel"><h2>Итого</h2>' +
        '<div class="totals">' +
        "<div><span>Товары</span><span>" + money(t.subtotal) + "</span></div>" +
        '<div class="is-discount"><span>Скидка 10% на первый заказ</span><span>−' + money(t.discount) + "</span></div>" +
        "<div><span>Доставка</span><span>0 ₽, оплачивает GlissPro</span></div>" +
        '<div class="is-total"><span>Ориентировочно к оплате</span><span>' + money(t.total) + "</span></div>" +
        "</div>" +
        '<a class="btn btn--accent btn--block" href="checkout.html">Оформить заказ</a>' +
        '<p class="field__hint" style="margin-top:12px">Скидка проверяется на шаге оформления: она действует только на первый заказ. Совмещение с партнёрскими ценами уточняется.</p>' +
        "</aside></div>";
    }

    box.addEventListener("click", function (e) {
      var b = e.target.closest("[data-line]");
      if (!b) return;
      var idx = parseInt(b.getAttribute("data-line"), 10);
      var line = getCart()[idx];
      if (!line) return;
      var act = b.getAttribute("data-act");
      if (act === "remove") setQty(idx, 0);
      if (act === "inc") setQty(idx, line.qty + 1);
      if (act === "dec") setQty(idx, line.qty - 1);
      render();
    });
    box.addEventListener("change", function (e) {
      var inp = e.target.closest("[data-qty]");
      if (!inp) return;
      var idx = parseInt(inp.getAttribute("data-qty"), 10);
      var q = parseInt(inp.value, 10);
      setQty(idx, isNaN(q) ? 1 : Math.max(0, Math.min(99, q)));
      render();
    });
    render();
  }

  /* ---------- Checkout ---------- */
  function setVisible(nodes, value, attr) {
    nodes.forEach(function (el) {
      var show = el.getAttribute(attr) === value;
      el.hidden = !show;
      $$("input, select, textarea", el).forEach(function (i) { i.disabled = !show; });
    });
  }

  function buildDelivery(fd, method) {
    if (method === "tk") {
      return {
        method: "transport_company",
        cost: 0,
        city: fd.get("tk_city") || "",
        carrier: fd.get("tk_carrier") || "",
        address_or_pickup: fd.get("tk_address") || "",
        comment: fd.get("tk_comment") || ""
      };
    }
    if (method === "spb") {
      return {
        method: "spb_courier",
        cost: 0,
        city: "Санкт-Петербург",
        address: fd.get("spb_address") || "",
        date: fd.get("spb_date") || null,
        comment: fd.get("spb_comment") || ""
      };
    }
    return {
      method: "pickup",
      cost: 0,
      pickup_point: fd.get("pickup_point") || "",
      comment: ""
    };
  }

  function renderStatus(orderId) {
    var orders = read(KEYS.orders, []);
    var o = null;
    orders.forEach(function (x) { if (x.order_id === orderId) o = x; });
    if (!o) return;
    var st = o.payment.status;
    var el = $("#order-status");
    el.textContent = STATUS_TEXT[st] || st;
    el.setAttribute("data-status", st);
    $("#order-json").textContent = JSON.stringify(o, null, 2);
    var simBox = $("#sim-box");
    simBox.hidden = o.payment.method === "invoice" || st !== "awaiting_payment";
    $("#order-note").textContent = o.payment.method === "invoice"
      ? "Счёт выставит менеджер. Статус «Оплачен» появится после поступления денег."
      : "Статус «Оплачен» ставится только по серверному уведомлению (webhook) платёжного сервиса. Переход на страницу результата его не меняет.";
  }

  function simulatePayment(orderId, status) {
    var orders = read(KEYS.orders, []);
    orders.forEach(function (o) {
      if (o.order_id === orderId) o.payment.status = status;
      if (o.order_id === orderId && status === "paid") {
        track("payment_confirmed", { order_id: orderId, value: o.amounts.total });
      }
    });
    write(KEYS.orders, orders);
    renderStatus(orderId);
  }

  function initCheckout() {
    var form = $("#checkout-form");
    if (!form) return;
    var lines = cartLines();
    var layout = $("#checkout-layout");
    if (!lines.length) {
      $("#checkout-empty").hidden = false;
      if (layout) layout.hidden = true;
      return;
    }

    var pickup = $("#pickup-select");
    pickup.innerHTML = PICKUP_POINTS.map(function (p) { return "<option>" + esc(p) + "</option>"; }).join("");

    $("#checkout-items").innerHTML = lines.map(function (l) {
      return "<li>" + esc(l.product.name) + " · " + esc(l.variant.label) + " × " + l.qty + " — " + money(l.lineTotal) + "</li>";
    }).join("");

    function toggleBlocks() {
      setVisible($$("[data-buyer]", form), form.elements.buyer_type.value, "data-buyer");
      setVisible($$("[data-delivery]", form), form.elements.delivery.value, "data-delivery");
    }

    function updateTotals() {
      var contact = {
        phone: form.elements.phone.value,
        email: form.elements.email.value
      };
      var first = firstOrderState(contact);
      var t = totalsFor(lines, first === true);
      var note;
      if (first === null) note = "Укажите телефон или email, чтобы проверить первый заказ.";
      else if (first) note = "Первый заказ: скидка 10% применена.";
      else note = "Контакт уже есть в истории заказов: скидка 10% не применяется.";
      $("#discount-note").textContent = note;
      $("#sum-subtotal").textContent = money(t.subtotal);
      $("#sum-discount").textContent = t.discount ? "−" + money(t.discount) : "0 ₽";
      $("#sum-total").textContent = money(t.total);
    }

    form.addEventListener("input", updateTotals);
    form.addEventListener("change", function () {
      toggleBlocks();
      updateTotals();
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!form.reportValidity()) return;
      var fd = new FormData(form);
      var contact = {
        name: fd.get("contact_name") || "",
        phone: fd.get("phone") || "",
        email: fd.get("email") || ""
      };
      var first = firstOrderState(contact);
      var t = totalsFor(lines, first === true);
      var buyerType = fd.get("buyer_type");
      var payment = fd.get("payment");

      var order = {
        order_id: "GP-" + Date.now().toString(36).toUpperCase().slice(-6),
        created_at: new Date().toISOString(),
        source: { page: "checkout.html", form: "order" },
        crm: { pipeline: "Интернет-магазин", stage: "Новый заказ" },
        buyer_type: buyerType,
        company: buyerType === "company"
          ? { name: fd.get("company_name") || "", inn: fd.get("inn") || "" }
          : null,
        contact: contact,
        items: lines.map(function (l) {
          return {
            sku: l.product.sku,
            name: l.product.name,
            variant: l.variant.label,
            qty: l.qty,
            price: l.variant.price,
            sum: l.lineTotal
          };
        }),
        amounts: {
          subtotal: t.subtotal,
          discount: t.discount,
          discount_reason: first === true ? "first_order_10_percent" : null,
          delivery: 0,
          total: t.total
        },
        first_order: first === true,
        delivery: buildDelivery(fd, fd.get("delivery")),
        payment: {
          method: payment,
          status: payment === "invoice" ? "awaiting_invoice" : "awaiting_payment"
        },
        comment: fd.get("comment") || ""
      };

      var orders = read(KEYS.orders, []);
      orders.push(order);
      write(KEYS.orders, orders);
      rememberCustomer(contact);
      write(KEYS.cart, []);
      renderCounts(true);
      track("order_created", { order_id: order.order_id, value: t.total, payment_method: payment });

      layout.hidden = true;
      $("#order-result").hidden = false;
      $("#order-number").textContent = order.order_id;
      renderStatus(order.order_id);
      window.scrollTo({ top: 0, behavior: "smooth" });
    });

    $$("[data-sim]").forEach(function (b) {
      b.addEventListener("click", function () {
        var orderId = $("#order-number").textContent;
        simulatePayment(orderId, b.getAttribute("data-sim"));
      });
    });

    toggleBlocks();
    updateTotals();
  }

  /* ---------- Forms (демо без отправки) ---------- */
  function initForms() {
    $$("form[data-form]").forEach(function (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        if (!form.reportValidity()) return;
        track("form_submit", { form_type: form.getAttribute("data-form") });
        form.hidden = true;
        var ok = form.parentNode.querySelector(".form-success");
        if (ok) ok.hidden = false;
      });
    });
  }

  /* ---------- Global handlers ---------- */
  function bindGlobal() {
    document.addEventListener("click", function (e) {
      var nav = e.target.closest(".nav-toggle");
      if (nav) {
        var open = $("#site-nav").classList.toggle("is-open");
        nav.setAttribute("aria-expanded", String(open));
        return;
      }
      var add = e.target.closest("[data-add]");
      if (add) {
        addToCart(add.getAttribute("data-add"), 0, 1);
        showToast("Добавлено в корзину");
        return;
      }
      var cmp = e.target.closest("[data-compare]");
      if (cmp) {
        toggleCompare(cmp.getAttribute("data-compare"));
        return;
      }
      var reset = e.target.closest("[data-reset-demo]");
      if (reset) {
        if (window.confirm("Очистить корзину, сравнение и историю заказов в этом браузере?")) {
          [KEYS.cart, KEYS.compare, KEYS.customers, KEYS.orders].forEach(function (k) {
            localStorage.removeItem(k);
          });
          window.location.reload();
        }
        return;
      }
      var tel = e.target.closest('a[href^="tel:"]');
      if (tel) track("phone_click", { location: window.location.pathname });
    });
  }

  function boot() {
    renderChrome();
    bindGlobal();
    renderCounts(false);
    initForms();
    initCatalog();
    initProduct();
    initCompare();
    initCart();
    initCheckout();
    syncCompareButtons();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
