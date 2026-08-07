/* Progressive enhancement only. With JS off you still get every block, every
 * link, and text you can select and copy by hand. */
(function () {
  'use strict';

  var shout = document.getElementById('shout');
  var shoutTimer = null;

  function say(message) {
    if (!shout) return;
    shout.textContent = message;
    shout.setAttribute('data-on', '');
    clearTimeout(shoutTimer);
    shoutTimer = setTimeout(function () { shout.removeAttribute('data-on'); }, 2200);
  }

  // --- copy ------------------------------------------------------------
  // textContent, not innerHTML: the field spans are styling, so what lands on
  // the clipboard is the plain text exactly as it is written in the YAML.

  function fallbackCopy(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(area);
    return ok;
  }

  function flash(button, state, label) {
    var text = button.querySelector('.copy__text');
    var original = button.getAttribute('data-label') || (text && text.textContent) || 'Copy';
    button.setAttribute('data-label', original);
    button.setAttribute('data-state', state);
    if (text) text.textContent = label;
    setTimeout(function () {
      button.removeAttribute('data-state');
      if (text) text.textContent = original;
    }, 1800);
  }

  function copyBlock(button) {
    var target = document.getElementById(button.getAttribute('data-copy'));
    if (!target) return;
    var text = target.textContent;
    var fields = (text.match(/\[[^\[\]\n]{0,60}\]/g) || []).length;
    var done = function () {
      flash(button, 'done', 'Copied');
      say(fields
        ? 'Copied. ' + fields + ' field' + (fields === 1 ? '' : 's') + ' to fill in.'
        : 'Copied.');
    };
    var failed = function () {
      flash(button, 'failed', 'Select it');
      selectBlock(target);
      say('Could not reach the clipboard. The block is selected — press Ctrl+C.');
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {
        if (fallbackCopy(text)) done(); else failed();
      });
    } else if (fallbackCopy(text)) {
      done();
    } else {
      failed();
    }
  }

  function selectBlock(el) {
    var range = document.createRange();
    range.selectNodeContents(el);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  document.addEventListener('click', function (e) {
    var button = e.target.closest('[data-copy]');
    if (button) copyBlock(button);
  });

  // Clicking into a block selects the whole thing, for anyone who would rather
  // copy by keyboard than trust a button.
  Array.prototype.forEach.call(document.querySelectorAll('.paste'), function (pre) {
    pre.addEventListener('dblclick', function () { selectBlock(pre); });
  });

  // --- hover summaries on trial links ----------------------------------
  var tip = document.getElementById('tip');

  function showTip(el) {
    var text = el.getAttribute('data-summary');
    if (!text || !tip) return;
    tip.textContent = text;
    tip.hidden = false;
    var r = el.getBoundingClientRect();
    tip.style.top = (window.scrollY + r.bottom + 6) + 'px';
    tip.style.left = (window.scrollX + r.left) + 'px';
    var tr = tip.getBoundingClientRect();
    if (tr.right > window.innerWidth - 8) {
      tip.style.left = Math.max(8, window.scrollX + window.innerWidth - tr.width - 8) + 'px';
    }
  }

  function hideTip() { if (tip) tip.hidden = true; }

  document.addEventListener('mouseover', function (e) {
    var el = e.target.closest('[data-summary]');
    if (el) showTip(el);
  });
  document.addEventListener('mouseout', function (e) {
    if (e.target.closest('[data-summary]')) hideTip();
  });
  document.addEventListener('focusin', function (e) {
    var el = e.target.closest('[data-summary]');
    if (el) showTip(el); else hideTip();
  });
  window.addEventListener('scroll', hideTip, { passive: true });

  // --- filtering and search --------------------------------------------
  var input = document.getElementById('search');
  var results = document.getElementById('search-results');
  var noresults = document.getElementById('noresults');
  var cards = Array.prototype.slice.call(document.querySelectorAll('.browse .card'));
  var topicblocks = Array.prototype.slice.call(document.querySelectorAll('.topicblock'));
  var chips = Array.prototype.slice.call(document.querySelectorAll('.chip'));
  var index = null;
  var kindFilter = '';

  function filterCards(q) {
    if (!cards.length) return;
    var shown = 0;
    cards.forEach(function (card) {
      var hay = card.getAttribute('data-search') || '';
      var hit = (!q || hay.indexOf(q) !== -1) &&
        (!kindFilter || hay.indexOf(kindFilter) !== -1);
      card.hidden = !hit;
      if (hit) shown++;
    });
    topicblocks.forEach(function (block) {
      var any = Array.prototype.some.call(block.querySelectorAll('.card'), function (c) {
        return !c.hidden;
      });
      block.hidden = !any;
    });
    if (noresults) noresults.hidden = shown !== 0;
  }

  chips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      chips.forEach(function (c) { c.classList.remove('chip--on'); });
      chip.classList.add('chip--on');
      kindFilter = chip.getAttribute('data-filter') || '';
      filterCards(input ? input.value.trim().toLowerCase() : '');
    });
  });

  function loadIndex() {
    if (index !== null) return Promise.resolve(index);
    return fetch('/autotexts.json')
      .then(function (r) { return r.json(); })
      .then(function (d) { index = d; return d; })
      .catch(function () { index = []; return index; });
  }

  function renderResults(q) {
    if (!results) return;
    if (!q) { results.hidden = true; results.innerHTML = ''; return; }
    loadIndex().then(function (data) {
      var hits = data.filter(function (r) { return r.h.indexOf(q) !== -1; }).slice(0, 12);
      if (!hits.length) {
        results.innerHTML = '<a href="#" aria-disabled="true"><span class="r-meta">' +
          'No block matches that</span></a>';
        results.hidden = false;
        return;
      }
      results.innerHTML = hits.map(function (r) {
        return '<a href="/t/' + r.s + '/"><span class="r-title">' + r.t + '</span>' +
          '<span class="r-meta">' + r.p + ' · ' + r.k + ' — ' + r.d + '</span></a>';
      }).join('');
      results.hidden = false;
    });
  }

  if (input) {
    input.addEventListener('input', function () {
      var q = input.value.trim().toLowerCase();
      if (cards.length) filterCards(q); else renderResults(q);
    });
    input.addEventListener('focus', function () {
      if (!cards.length && input.value.trim()) renderResults(input.value.trim().toLowerCase());
    });
    input.form.addEventListener('submit', function (e) { e.preventDefault(); });
    document.addEventListener('click', function (e) {
      if (results && !input.form.contains(e.target)) results.hidden = true;
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        input.value = '';
        filterCards('');
        if (results) results.hidden = true;
        input.blur();
      }
    });
  }

  // "/" focuses search, the way it does in every tool that expects to be used
  // in a hurry. Ctrl-K too, for the people who have that in their fingers.
  window.addEventListener('keydown', function (e) {
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) ||
      document.activeElement.isContentEditable;
    if (!input) return;
    if ((e.key === '/' && !typing) || ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K'))) {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });

  // --- nav dropdowns ----------------------------------------------------
  var navgroups = Array.prototype.slice.call(document.querySelectorAll('.navgroup'));
  navgroups.forEach(function (d) {
    d.addEventListener('toggle', function () {
      if (!d.open) return;
      navgroups.forEach(function (o) { if (o !== d) o.open = false; });
    });
  });
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.navgroup')) navgroups.forEach(function (d) { d.open = false; });
  });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') navgroups.forEach(function (d) { d.open = false; });
  });
})();
