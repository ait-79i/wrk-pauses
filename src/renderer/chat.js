// Fenêtre « Discussion » de l'équipe (application Windows). Contrat : docs/contrat-api-phases-2-3.md.
// Données : window.psChat (processus principal, la clé de l'appareil n'arrive jamais ici),
// window.psTeam.choose pour choisir son groupe depuis une carte d'horaires,
// window.psStore (team, teamDay, teamChannels, teamRealtime, isRamadanMode). Pont : src/main/chat-preload.ts.
// Tout texte venant du serveur passe par des nœuds texte : jamais d'innerHTML.

(function () {
    const REACTIONS = ['👍', '❤️', '🤲', '✅', '😂', '😮'];
    const LATIN = { DHUHR: 'Dhuhr', ASR: 'Asr', JUMUA: 'Jumu\'a' };
    const MAX_BODY = 2000;

    const app = document.getElementById('chatApp');
    const tabsEl = document.getElementById('chatTabs');
    const teamEl = document.getElementById('chatTeam');
    const listEl = document.getElementById('chatList');
    const footerEl = document.getElementById('chatFooter');
    const statusEl = document.getElementById('chatStatus');
    const newPill = document.getElementById('chatNewPill');
    const offlineEl = document.getElementById('chatOffline');
    const announceEl = document.getElementById('chatAnnounce');

    const state = {
        team: null,
        teamDay: null,
        channels: [],
        channel: new URLSearchParams(location.search).get('channel'),
        messages: [],        // ordre croissant
        hasMore: false,
        loading: false,
        replyTo: null,       // message auquel on répond
        announce: false,
        pickerFor: null,     // id du message dont le choix de réaction est ouvert
        confirmDelete: null, // id du message à supprimer (2e clic)
        sending: false,
        choosing: false
    };
    const lastRead = new Map(); // canal -> dernier id marqué lu
    let confirmTimer = null;
    let muteTimer = null;

    // ---------------------------------------------------------------- Outils

    const hhmm = (mins) => `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;
    const el = (tag, attrs = {}, ...children) => {
        const node = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (v === undefined || v === null || v === false) continue;
            if (k === 'class') node.className = v;
            else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
            else node.setAttribute(k, v === true ? '' : v);
        }
        for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
        return node;
    };
    const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const timeOf = (iso) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const dayKey = (iso) => {
        const d = new Date(iso);
        return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    };
    function dayLabel(key) {
        const today = dayKey(new Date().toISOString());
        const y = new Date();
        y.setDate(y.getDate() - 1);
        if (key === today) return 'Aujourd\'hui';
        if (key === dayKey(y.toISOString())) return 'Hier';
        const [yy, mm, dd] = key.split('-').map(Number);
        return new Date(yy, mm - 1, dd).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    }
    function scheduleDate(date) {
        const [yy, mm, dd] = date.split('-').map(Number);
        return new Date(yy, mm - 1, dd).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    }

    const current = () => state.channels.find((c) => c.key === state.channel) || null;
    const isMine = (m) => Boolean(state.team && m.author.type === 'member' && m.author.id === state.team.memberId);
    const mentionsMe = (m) => Boolean(state.team && m.mentions.some((x) => x.memberId === state.team.memberId));

    function showStatus(text) {
        statusEl.hidden = !text;
        statusEl.textContent = text || '';
    }

    // ---------------------------------------------------------------- Onglets

    function renderTabs() {
        tabsEl.replaceChildren();
        tabsEl.hidden = state.channels.length < 2;
        for (const c of state.channels) {
            const selected = c.key === state.channel;
            tabsEl.append(el('button', {
                type: 'button', role: 'tab', class: 'chat-tab', id: `tab-${c.key}`,
                'aria-selected': String(selected), 'aria-controls': 'chatList', tabindex: selected ? '0' : '-1',
                onclick: () => openChannel(c.key),
                onkeydown: onTabKey
            }, c.name, c.unread > 0 && !selected
                ? el('span', { class: 'chat-badge', 'aria-label': `${c.unread} non lu${c.unread > 1 ? 's' : ''}` }, String(Math.min(c.unread, 99)))
                : null));
        }
    }

    function onTabKey(e) {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const i = state.channels.findIndex((c) => c.key === state.channel);
        const next = state.channels[(i + (e.key === 'ArrowRight' ? 1 : -1) + state.channels.length) % state.channels.length];
        if (next) openChannel(next.key).then(() => document.getElementById(`tab-${next.key}`)?.focus());
    }

    // ---------------------------------------------------------------- Messages

    function renderBody(m) {
        const p = el('p', { class: 'msg-body', dir: 'auto' });
        const names = m.mentions.map((x) => x.name).filter(Boolean).sort((a, b) => b.length - a.length);
        if (!names.length) {
            p.textContent = m.body;
            return p;
        }
        const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const re = new RegExp(`@(${escaped.join('|')})`, 'giu');
        let last = 0;
        for (const match of m.body.matchAll(re)) {
            if (match.index > last) p.append(m.body.slice(last, match.index));
            p.append(el('span', { class: 'msg-mention', dir: 'auto' }, match[0]));
            last = match.index + match[0].length;
        }
        if (last < m.body.length) p.append(m.body.slice(last));
        return p;
    }

    /** Extrait sur une ligne : « @Nom » isolé pour rester d'un bloc dans un texte mêlant arabe et français */
    function renderExcerpt(raw, cls) {
        const text = String(raw ?? '');
        const span = el('span', { class: cls, dir: 'auto' });
        let last = 0;
        for (const match of text.matchAll(/@[\p{L}\p{M}\p{N}._'-]+/gu)) {
            if (match.index > last) span.append(text.slice(last, match.index));
            span.append(el('bdi', { class: 'msg-mention-inline' }, match[0]));
            last = match.index + match[0].length;
        }
        if (last < text.length) span.append(text.slice(last));
        return span;
    }

    function renderReactions(m) {
        const row = el('div', { class: 'msg-reactions' });
        for (const r of m.reactions) {
            if (!r.count) continue;
            row.append(el('button', {
                type: 'button', class: `msg-reaction${r.mine ? ' is-mine' : ''}`, 'aria-pressed': String(r.mine),
                'data-focus': `${m.id}:r:${r.emoji}`,
                'aria-label': `${r.emoji} ${r.count}${r.mine ? ', dont vous' : ''}`,
                onclick: () => react(m, r.emoji)
            }, el('span', { 'aria-hidden': 'true' }, r.emoji), el('span', { class: 'msg-reaction-count' }, String(r.count))));
        }
        if (state.pickerFor === m.id) {
            const picker = el('div', { class: 'msg-picker', role: 'group', 'aria-label': 'Choisir une réaction' },
                REACTIONS.map((emoji, i) => el('button', {
                    type: 'button', class: 'msg-picker-btn', 'data-focus': `${m.id}:p:${i}`,
                    'aria-label': `Réagir avec ${emoji}`,
                    onclick: () => { state.pickerFor = null; react(m, emoji); },
                    onkeydown: (e) => { if (e.key === 'Escape') closePicker(m); }
                }, emoji)));
            row.append(picker);
        }
        return row.childElementCount ? row : null;
    }

    function closePicker(m) {
        state.pickerFor = null;
        renderList({ focus: `${m.id}:react` });
    }

    function renderActions(m) {
        const ch = current();
        if (m.deleted || !ch) return null;
        const canDelete = isMine(m) || (ch.canModerate && m.author.type !== 'system');
        const actions = el('div', { class: 'msg-actions' });
        if (ch.canPost && m.kind !== 'SCHEDULE') {
            actions.append(el('button', {
                type: 'button', class: 'msg-action', 'data-focus': `${m.id}:reply`,
                onclick: () => { state.replyTo = m; renderFooter(); focusComposer(); }
            }, 'Répondre'));
        }
        actions.append(el('button', {
            type: 'button', class: 'msg-action', 'data-focus': `${m.id}:react`, 'aria-expanded': String(state.pickerFor === m.id),
            onclick: () => {
                state.pickerFor = state.pickerFor === m.id ? null : m.id;
                renderList({ focus: state.pickerFor ? `${m.id}:p:0` : `${m.id}:react` });
            }
        }, 'Réagir'));
        if (canDelete) {
            const confirming = state.confirmDelete === m.id;
            actions.append(el('button', {
                type: 'button', class: `msg-action msg-action--danger${confirming ? ' is-confirm' : ''}`, 'data-focus': `${m.id}:del`,
                onclick: () => removeMessage(m)
            }, confirming ? 'Confirmer la suppression' : 'Supprimer'));
        }
        return actions;
    }

    /** Carte d'une publication : les groupes du jour se choisissent directement */
    function renderSchedule(m) {
        const s = m.schedule;
        const day = state.teamDay;
        const latest = !state.messages.some((x) => x.id > m.id && x.kind === 'SCHEDULE' && x.schedule
            && x.schedule.date === s.date && x.schedule.prayer === s.prayer);
        const prayer = day && day.date === s.date ? day.prayers.find((p) => p.prayer === s.prayer) : null;
        const interactive = Boolean(latest && prayer && prayer.published && s.prayer !== 'JUMUA' && state.channel === `cat:${state.team?.categoryId}`);
        const isToday = day && s.date === day.today;
        const mine = prayer ? prayer.slots.find((x) => x.groupId === prayer.myGroupId) : null;
        const locked = Boolean(isToday && mine && mine.timeMins <= day.nowMins);

        const card = el('div', { class: 'sched' },
            el('div', { class: 'sched-head' },
                el('span', { class: 'sched-kind' }, s.change === 'updated' ? 'Horaires modifiés' : 'Horaires publiés'),
                el('span', { class: 'sched-when' }, `${LATIN[s.prayer] || s.prayer} · ${scheduleDate(s.date)}`),
                el('time', { class: 'msg-time sched-time', datetime: m.createdAt }, timeOf(m.createdAt))));

        if (s.prayer === 'JUMUA') {
            card.append(el('p', { class: 'sched-jumua' }, `Jumu'a à ${hhmm(s.slots[0]?.timeMins ?? 0)}`));
        } else {
            const chips = el('div', { class: 'sched-chips' });
            for (const slot of s.slots) {
                const moved = s.movedGroupIds.includes(slot.groupId) || (s.addedGroupIds || []).includes(slot.groupId);
                const label = [el('strong', {}, slot.groupName || ''), ` ${hhmm(slot.timeMins)}`];
                if (!interactive) {
                    chips.append(el('span', { class: `team-chip sched-chip is-static${moved ? ' is-moved' : ''}` }, label));
                    continue;
                }
                const live = prayer.slots.find((x) => x.groupId === slot.groupId);
                const selected = slot.groupId === prayer.myGroupId;
                const past = isToday && slot.timeMins <= day.nowMins;
                chips.append(el('button', {
                    type: 'button', class: `team-chip sched-chip${selected ? ' is-selected' : ''}${moved ? ' is-moved' : ''}`,
                    'aria-pressed': String(selected), 'data-focus': `${m.id}:g:${slot.groupId}`,
                    disabled: state.choosing || past || locked || !live,
                    title: selected ? 'Votre groupe. Cliquez pour le retirer.' : `Prier avec ${slot.groupName}`,
                    onclick: () => choose(s, selected ? null : slot.groupId, `${m.id}:g:${slot.groupId}`)
                }, label, live ? el('span', { class: 'team-chip-count', 'aria-label': `${live.count} membres` }, String(live.count)) : null));
            }
            card.append(chips);
            if (s.removedGroupIds.length) {
                card.append(el('p', { class: 'sched-note' }, `${s.removedGroupIds.length > 1 ? 'Groupes retirés' : 'Groupe retiré'} de cette prière.`));
            }
            if (!latest) card.append(el('p', { class: 'sched-note' }, 'Une mise à jour plus récente suit.'));
            else if (interactive && !mine) card.append(el('p', { class: 'sched-note' }, 'Choisissez votre groupe pour recevoir son rappel.'));
        }
        return card;
    }

    function renderMessage(m) {
        const mine = isMine(m);
        const classes = ['msg', `msg--${m.kind.toLowerCase()}`];
        if (mine) classes.push('is-mine');
        if (m.deleted) classes.push('is-deleted');
        if (!m.deleted && mentionsMe(m)) classes.push('is-mention');

        // tabindex -1 : le focus peut revenir sur le message (après une suppression)
        const node = el('article', {
            class: classes.join(' '), 'data-id': String(m.id), 'data-focus': `${m.id}:msg`, tabindex: '-1',
            'aria-label': `${m.author.name}, ${timeOf(m.createdAt)}`
        });
        const meta = el('div', { class: 'msg-meta' },
            m.kind === 'ANNOUNCEMENT' ? el('span', { class: 'msg-tag' }, 'Annonce') : null,
            el('span', { class: 'msg-author', dir: 'auto' }, mine ? 'Vous' : m.author.name),
            m.author.type === 'admin' ? el('span', { class: 'msg-role' }, 'admin') : null,
            el('time', { class: 'msg-time', datetime: m.createdAt }, timeOf(m.createdAt)));
        // Carte d'horaires : l'auteur (« Horaires ») ferait doublon avec son titre
        if (m.kind !== 'SCHEDULE') node.append(meta);

        if (m.deleted) {
            node.append(el('p', { class: 'msg-body msg-body--deleted' }, 'Message supprimé'));
            return node;
        }
        if (m.replyTo) {
            node.append(el('button', {
                type: 'button', class: 'msg-quote', title: 'Afficher le message d\'origine',
                onclick: () => jumpTo(m.replyTo.id)
            }, el('span', { class: 'msg-quote-author', dir: 'auto' }, m.replyTo.authorName),
            renderExcerpt(m.replyTo.excerpt, 'msg-quote-text')));
        }
        if (m.kind === 'SCHEDULE' && m.schedule) node.append(renderSchedule(m));
        else node.append(renderBody(m));
        node.append(renderReactions(m) || '', renderActions(m) || '');
        return node;
    }

    function jumpTo(id) {
        const target = listEl.querySelector(`[data-id="${Number(id)}"]`);
        if (!target) {
            showStatus('Le message d\'origine est plus ancien : chargez les messages précédents.');
            return;
        }
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        target.classList.add('is-flash');
        setTimeout(() => target.classList.remove('is-flash'), 1200);
    }

    const atBottom = () => listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 40;

    /**
     * Reconstruit la liste. opts.keep : 'bottom' (coller en bas), 'top-anchor' (messages anciens ajoutés),
     * sinon on garde la position. opts.focus : clé data-focus à refocaliser.
     */
    function renderList(opts = {}) {
        const stick = opts.keep === 'bottom' || (opts.keep !== 'top-anchor' && atBottom());
        const fromBottom = listEl.scrollHeight - listEl.scrollTop;
        const top = listEl.scrollTop;
        const focusKey = opts.focus || document.activeElement?.getAttribute?.('data-focus');

        listEl.replaceChildren();
        const ch = current();
        if (!ch) {
            listEl.append(el('p', { class: 'chat-empty' }, state.loading
                ? 'Chargement…'
                : 'Aucune discussion disponible. Vérifiez votre catégorie dans la fenêtre principale, ou demandez à un admin de l\'équipe.'));
            return;
        }
        if (state.hasMore) {
            listEl.append(el('button', {
                type: 'button', class: 'chat-more', disabled: state.loading, 'data-focus': 'more', onclick: loadOlder
            }, state.loading ? 'Chargement…' : 'Afficher les messages précédents'));
        }
        if (!state.messages.length && !state.loading) {
            listEl.append(el('p', { class: 'chat-empty' }, 'Aucun message pour l\'instant. Écrivez le premier.'));
        }
        let lastDay = null;
        for (const m of state.messages) {
            const d = dayKey(m.createdAt);
            if (d !== lastDay) {
                listEl.append(el('div', { class: 'chat-day', role: 'separator' }, el('span', {}, dayLabel(d))));
                lastDay = d;
            }
            listEl.append(renderMessage(m));
        }

        if (stick) listEl.scrollTop = listEl.scrollHeight;
        else if (opts.keep === 'top-anchor') listEl.scrollTop = listEl.scrollHeight - fromBottom;
        else listEl.scrollTop = top;
        if (stick) newPill.hidden = true;
        if (focusKey) listEl.querySelector(`[data-focus="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
    }

    // ---------------------------------------------------------------- Saisie

    function knownNames() {
        const names = new Map();
        const me = state.team?.memberName;
        for (const m of state.messages) {
            if (m.author.type !== 'system' && m.author.name) names.set(fold(m.author.name), m.author.name);
            for (const x of m.mentions) names.set(fold(x.name), x.name);
        }
        if (me) names.delete(fold(me));
        return [...names.values()].sort((a, b) => a.localeCompare(b, 'fr'));
    }

    let composer = null;   // textarea
    let suggest = { items: [], index: 0, start: -1 };

    function focusComposer() {
        if (composer) setTimeout(() => composer.focus(), 0);
    }

    /** Droits d'écriture d'un canal : le pied de page n'est reconstruit que s'ils changent */
    const rightsOf = (ch) => JSON.stringify(ch ? [ch.key, ch.canPost, ch.canAnnounce, ch.canModerate, ch.mutedUntil] : null);

    function renderFooter() {
        const ch = current();
        const draft = composer ? composer.value : '';
        // Saisie en cours : focus et curseur rendus après reconstruction
        const hadFocus = Boolean(composer && document.activeElement === composer);
        const sel = composer ? [composer.selectionStart, composer.selectionEnd] : null;
        footerEl.replaceChildren();
        composer = null;
        if (!ch) return;

        const mutedUntil = ch.mutedUntil && new Date(ch.mutedUntil).getTime() > Date.now() ? new Date(ch.mutedUntil) : null;
        clearTimeout(muteTimer);
        if (mutedUntil) {
            // Fin du silence : droits relus et zone de saisie rétablie
            const wait = mutedUntil.getTime() - Date.now() + 1000;
            if (wait < 2 ** 31 - 1) muteTimer = setTimeout(() => refreshChannels().then(() => { renderTabs(); renderFooter(); }), wait);
            const sameDay = dayKey(mutedUntil.toISOString()) === dayKey(new Date().toISOString());
            const when = sameDay ? timeOf(mutedUntil.toISOString())
                : `${mutedUntil.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })} à ${timeOf(mutedUntil.toISOString())}`;
            footerEl.append(el('p', { class: 'chat-readonly' }, `Un admin vous a réduit au silence jusqu'à ${when}. Vous pouvez lire la discussion.`));
            return;
        }
        if (!ch.canPost) {
            footerEl.append(el('p', { class: 'chat-readonly' }, 'Vous pouvez lire cette discussion, mais pas y écrire.'));
            return;
        }

        if (state.replyTo) {
            const r = state.replyTo;
            footerEl.append(el('div', { class: 'chat-replying' },
                el('div', { class: 'chat-replying-text' },
                    el('span', { class: 'chat-replying-label' }, 'Réponse à ',
                        el('bdi', {}, isMine(r) ? 'vous-même' : r.author.name)),
                    renderExcerpt(r.body.slice(0, 80), 'chat-replying-excerpt')),
                el('button', {
                    type: 'button', class: 'chat-icon-btn', 'aria-label': 'Annuler la réponse',
                    onclick: () => { state.replyTo = null; renderFooter(); focusComposer(); }
                }, '×')));
        }

        const listbox = el('ul', { class: 'chat-suggest', id: 'chatSuggest', role: 'listbox', 'aria-label': 'Membres', hidden: true });
        composer = el('textarea', {
            class: 'chat-input', rows: '1', maxlength: String(MAX_BODY), dir: 'auto',
            placeholder: state.announce ? 'Votre annonce…' : 'Écrire un message… (@ pour mentionner)',
            'aria-label': 'Message', 'aria-autocomplete': 'list', 'aria-controls': 'chatSuggest', 'aria-expanded': 'false'
        });
        composer.value = draft;
        composer.addEventListener('input', () => { autosize(); updateSuggest(listbox); });
        composer.addEventListener('keydown', (e) => onComposerKey(e, listbox));
        composer.addEventListener('blur', () => setTimeout(() => closeSuggest(listbox), 150));

        const send = el('button', { type: 'submit', class: 'team-btn team-btn--primary chat-send', disabled: state.sending }, state.announce ? 'Publier' : 'Envoyer');
        const form = el('form', { class: 'chat-form', novalidate: true }, listbox, el('div', { class: 'chat-form-row' }, composer, send));
        form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
        footerEl.append(form);

        if (ch.canAnnounce) {
            const box = el('input', { type: 'checkbox', class: 'switch-input', role: 'switch', checked: state.announce });
            box.addEventListener('change', () => { state.announce = box.checked; renderFooter(); focusComposer(); });
            footerEl.append(el('label', { class: 'chat-announce' }, box, el('span', { class: 'chat-switch', 'aria-hidden': 'true' }),
                el('span', {}, 'Publier comme annonce'),
                state.announce ? el('span', { class: 'chat-announce-hint' }, 'notifiée à tous les membres') : null));
        }
        autosize();
        if (hadFocus) {
            composer.focus({ preventScroll: true });
            if (sel) composer.setSelectionRange(Math.min(sel[0], draft.length), Math.min(sel[1], draft.length));
        }
    }

    function autosize() {
        if (!composer) return;
        composer.style.height = 'auto';
        composer.style.height = `${Math.min(composer.scrollHeight, 140)}px`;
        composer.style.overflowY = composer.scrollHeight > 140 ? 'auto' : 'hidden';
    }

    function updateSuggest(listbox) {
        const caret = composer.selectionStart;
        const before = composer.value.slice(0, caret);
        const match = /(^|\s)@([^\s@]{0,30})$/u.exec(before);
        if (!match) return closeSuggest(listbox);
        const q = fold(match[2]);
        const items = knownNames().filter((n) => fold(n).startsWith(q) || fold(n).includes(` ${q}`)).slice(0, 6);
        if (!items.length) return closeSuggest(listbox);
        suggest = { items, index: 0, start: caret - match[2].length - 1 };
        drawSuggest(listbox);
    }

    function drawSuggest(listbox) {
        listbox.replaceChildren(...suggest.items.map((name, i) => el('li', {
            role: 'option', id: `sug-${i}`, class: 'chat-suggest-item', 'aria-selected': String(i === suggest.index),
            onmousedown: (e) => { e.preventDefault(); pickSuggest(i, listbox); }
        }, `@${name}`)));
        listbox.hidden = false;
        composer.setAttribute('aria-expanded', 'true');
        composer.setAttribute('aria-activedescendant', `sug-${suggest.index}`);
    }

    function closeSuggest(listbox) {
        suggest = { items: [], index: 0, start: -1 };
        listbox.hidden = true;
        if (composer) {
            composer.setAttribute('aria-expanded', 'false');
            composer.removeAttribute('aria-activedescendant');
        }
    }

    function pickSuggest(i, listbox) {
        const name = suggest.items[i];
        if (!name || suggest.start < 0) return;
        const caret = composer.selectionStart;
        const text = composer.value;
        composer.value = `${text.slice(0, suggest.start)}@${name} ${text.slice(caret)}`;
        const pos = suggest.start + name.length + 2;
        composer.setSelectionRange(pos, pos);
        closeSuggest(listbox);
        autosize();
    }

    function onComposerKey(e, listbox) {
        if (suggest.items.length) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const n = suggest.items.length;
                suggest.index = (suggest.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
                drawSuggest(listbox);
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                pickSuggest(suggest.index, listbox);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                closeSuggest(listbox);
                return;
            }
        }
        if (e.key === 'Escape' && state.replyTo) {
            state.replyTo = null;
            renderFooter();
            focusComposer();
            return;
        }
        // Entrée envoie, Maj+Entrée va à la ligne
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            submit();
        }
    }

    // ---------------------------------------------------------------- Actions

    async function submit() {
        const ch = current();
        if (!composer || !ch || state.sending) return;
        const body = composer.value.trim();
        if (!body) return;
        if (body.length > MAX_BODY) {
            showStatus(`Message trop long : ${MAX_BODY} caractères au plus.`);
            return;
        }
        state.sending = true;
        const kind = state.announce && ch.canAnnounce ? 'ANNOUNCEMENT' : 'TEXT';
        const res = await window.psChat.post(ch.key, body, kind, state.replyTo ? state.replyTo.id : null);
        state.sending = false;
        if (!res.ok) {
            showStatus(res.message);
            renderFooter();
            focusComposer();
            if (/silence/i.test(res.message)) refreshChannels();
            return;
        }
        showStatus('');
        composer.value = '';
        state.replyTo = null;
        state.announce = false;
        upsert(res.value);
        renderList({ keep: 'bottom' });
        renderFooter();
        focusComposer();
    }

    async function react(m, emoji) {
        const res = await window.psChat.react(m.id, emoji);
        if (!res.ok) return showStatus(res.message);
        showStatus('');
        upsert(res.value);
        renderList({ focus: `${m.id}:react` });
    }

    async function removeMessage(m) {
        if (state.confirmDelete !== m.id) {
            state.confirmDelete = m.id;
            clearTimeout(confirmTimer);
            confirmTimer = setTimeout(() => { state.confirmDelete = null; renderList(); }, 4000);
            renderList({ focus: `${m.id}:del` });
            return;
        }
        clearTimeout(confirmTimer);
        state.confirmDelete = null;
        const res = await window.psChat.remove(m.id);
        if (!res.ok) return showStatus(res.message);
        showStatus('');
        upsert({ ...m, deleted: true, body: '', reactions: [] });
        // Le bouton n'existe plus : le focus va sur le message supprimé
        renderList({ focus: `${m.id}:msg` });
    }

    async function choose(s, groupId, focusKey) {
        state.choosing = true;
        renderList({ focus: focusKey });
        const res = await window.psTeam.choose(s.date, s.prayer, groupId);
        state.choosing = false;
        if (!res.ok) showStatus(res.message);
        else {
            showStatus('');
            state.teamDay = res.value;
        }
        renderList({ focus: focusKey });
    }

    function upsert(m) {
        if (m.channel !== state.channel) return false;
        const i = state.messages.findIndex((x) => x.id === m.id);
        if (i >= 0) {
            state.messages[i] = m;
            return false;
        }
        state.messages.push(m);
        state.messages.sort((a, b) => a.id - b.id);
        return true;
    }

    // ---------------------------------------------------------------- Chargement

    async function refreshChannels() {
        const res = await window.psChat.channels();
        if (!res.ok) {
            showStatus(res.message);
            return false;
        }
        state.channels = res.value;
        return true;
    }

    async function openChannel(key) {
        if (key === state.channel && state.messages.length) {
            renderTabs();
            return;
        }
        state.channel = key;
        state.messages = [];
        state.hasMore = false;
        state.replyTo = null;
        state.announce = false;
        state.pickerFor = null;
        state.loading = true;
        renderTabs();
        renderList();
        renderFooter();
        const res = await window.psChat.messages(key, null);
        if (state.channel !== key) return;
        state.loading = false;
        if (!res.ok) {
            showStatus(res.message);
            renderList();
            return;
        }
        showStatus('');
        state.messages = res.value.messages;
        state.hasMore = res.value.hasMore;
        renderList({ keep: 'bottom' });
        markReadIfSeen();
    }

    /** Derniers messages du canal ouvert, fusionnés (après une reconnexion : messages manqués) */
    async function reloadLatest() {
        const key = state.channel;
        if (!key || state.loading) return;
        const wasBottom = atBottom();
        const res = await window.psChat.messages(key, null);
        if (state.channel !== key) return;
        if (!res.ok) {
            showStatus(res.message);
            return;
        }
        showStatus('');
        const before = state.messages.length ? state.messages[state.messages.length - 1].id : 0;
        const fresh = res.value.messages;
        // Trou entre l'ancien et le nouveau lot : on repart du dernier lot
        if (state.messages.length && fresh.length && fresh[0].id > before && res.value.hasMore) {
            state.messages = fresh;
            state.hasMore = true;
        } else {
            for (const m of fresh) upsert(m);
            if (!state.messages.length) state.hasMore = res.value.hasMore;
        }
        const added = fresh.filter((m) => m.id > before && !isMine(m));
        renderList({ keep: wasBottom ? 'bottom' : undefined });
        if (added.length) {
            announce(added.length === 1 ? `Nouveau message de ${added[0].author.name}` : `${added.length} nouveaux messages`);
            if (!wasBottom) newPill.hidden = false;
        }
        markReadIfSeen();
    }

    async function loadOlder() {
        if (state.loading || !state.messages.length) return;
        const key = state.channel;
        state.loading = true;
        renderList({ keep: 'top-anchor', focus: 'more' });
        const res = await window.psChat.messages(key, state.messages[0].id);
        if (state.channel !== key) return;
        state.loading = false;
        if (!res.ok) {
            showStatus(res.message);
            renderList({ keep: 'top-anchor' });
            return;
        }
        const known = new Set(state.messages.map((m) => m.id));
        state.messages = [...res.value.messages.filter((m) => !known.has(m.id)), ...state.messages];
        state.hasMore = res.value.hasMore;
        renderList({ keep: 'top-anchor', focus: state.hasMore ? 'more' : null });
    }

    /** Marque lu quand la fenêtre est au premier plan et le bas de la liste visible */
    async function markReadIfSeen() {
        const ch = current();
        if (!ch || !state.messages.length || document.visibilityState !== 'visible' || !document.hasFocus()) return;
        if (!atBottom()) return;
        const lastId = state.messages[state.messages.length - 1].id;
        if ((lastRead.get(ch.key) || 0) >= lastId && !ch.unread) return;
        lastRead.set(ch.key, lastId);
        newPill.hidden = true;
        const res = await window.psChat.markRead(ch.key, lastId);
        if (!res.ok) lastRead.delete(ch.key);
    }

    // ---------------------------------------------------------------- Temps réel

    /** Annonce polie pour les lecteurs d'écran (la liste elle-même n'est pas une région live) */
    function announce(text) {
        announceEl.textContent = '';
        setTimeout(() => { announceEl.textContent = text; }, 50);
    }

    /** Canaux relus : pied de page reconstruit seulement si les droits changent, canal disparu remplacé */
    async function syncChannels() {
        const before = rightsOf(current());
        if (!(await refreshChannels())) return false;
        if (!current() && state.channels.length) {
            // Canal retiré (changement de catégorie, rôle retiré) : on ouvre le premier visible
            state.messages = [];
            await openChannel(state.channels[0].key);
            return true;
        }
        renderTabs();
        if (rightsOf(current()) !== before) {
            renderFooter();
            renderList();
        }
        return true;
    }

    function onServerEvent(ev) {
        if (!ev || !ev.type) return;
        if ((ev.type === 'message.created' || ev.type === 'message.updated') && ev.message) {
            if (ev.message.channel !== state.channel) return;
            const wasBottom = atBottom();
            const added = upsert(ev.message);
            if (state.pickerFor === ev.message.id && ev.message.deleted) state.pickerFor = null;
            renderList({ keep: added && (wasBottom || isMine(ev.message)) ? 'bottom' : undefined });
            if (added && !isMine(ev.message)) {
                if (!wasBottom) newPill.hidden = false;
                const m = ev.message;
                announce(m.kind === 'SCHEDULE'
                    ? 'Nouveaux horaires publiés'
                    : `${m.kind === 'ANNOUNCEMENT' ? 'Annonce' : 'Message'} de ${m.author.name} : ${m.body.slice(0, 120)}`);
            }
            markReadIfSeen();
        } else if (ev.type === 'ready') {
            renderOffline('open');
            if (renderGate()) return;
            // Reconnexion : canaux et messages manqués relus ; premier chargement raté : on recommence
            if (!state.channel || (!state.messages.length && !current())) {
                start();
                return;
            }
            syncChannels().then((ok) => { if (ok) reloadLatest(); });
        } else if (ev.type === 'member.status') {
            if (!renderGate()) syncChannels();
        }
    }

    function renderOffline(realtime) {
        offlineEl.hidden = realtime !== 'offline';
    }

    // ---------------------------------------------------------------- Thème et démarrage

    function applyTheme(on) {
        app.classList.toggle('ramadan-active', Boolean(on));
    }

    function renderTeam() {
        const t = state.team;
        teamEl.textContent = t ? `${t.categoryName} · ${t.teamName}` : '';
    }

    function renderGate() {
        const t = state.team;
        if (t && t.status === 'ACTIVE') return false;
        tabsEl.replaceChildren();
        footerEl.replaceChildren();
        listEl.replaceChildren(el('p', { class: 'chat-empty' }, !t
            ? 'Rejoignez une équipe depuis la fenêtre principale pour accéder à sa discussion.'
            : t.status === 'PENDING'
                ? 'Un admin doit valider votre demande avant que vous puissiez lire la discussion.'
                : 'Votre accès à l\'équipe est suspendu. Contactez un admin.'));
        return true;
    }

    async function start() {
        renderTeam();
        if (renderGate()) return;
        showStatus('');
        state.loading = true;
        renderList();
        if (!(await refreshChannels())) {
            state.loading = false;
            renderList();
            return;
        }
        const wanted = state.channels.find((c) => c.key === state.channel) || state.channels[0];
        state.channel = null;
        if (wanted) await openChannel(wanted.key);
        else {
            state.loading = false;
            renderList();
        }
    }

    window.psChat.onEvent(onServerEvent);
    window.psChat.onOpenChannel((key) => openChannel(key));

    listEl.addEventListener('scroll', () => { if (atBottom()) markReadIfSeen(); });
    newPill.addEventListener('click', () => {
        listEl.scrollTop = listEl.scrollHeight;
        newPill.hidden = true;
        markReadIfSeen();
    });
    window.addEventListener('focus', markReadIfSeen);
    document.addEventListener('visibilitychange', markReadIfSeen);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && state.pickerFor !== null) {
            const m = state.messages.find((x) => x.id === state.pickerFor);
            if (m) closePicker(m);
        }
    });

    window.psStore.get(['team', 'teamDay', 'teamRealtime', 'isRamadanMode']).then((res) => {
        state.team = res.team || null;
        state.teamDay = res.teamDay || null;
        applyTheme(res.isRamadanMode);
        renderOffline(res.teamRealtime);
        start();
    });

    window.psStore.onChanged((changes) => {
        if (changes.isRamadanMode) applyTheme(changes.isRamadanMode.newValue);
        if (changes.teamRealtime) renderOffline(changes.teamRealtime.newValue);
        if (changes.teamDay) {
            state.teamDay = changes.teamDay.newValue || null;
            if (!state.choosing && state.messages.some((m) => m.kind === 'SCHEDULE')) renderList();
        }
        if (changes.teamChannels && Array.isArray(changes.teamChannels.newValue)) {
            const before = rightsOf(current());
            state.channels = changes.teamChannels.newValue;
            renderTabs();
            // Droits d'écriture modifiés (silence levé, rôle) : la zone de saisie suit
            if (rightsOf(current()) !== before) {
                renderFooter();
                renderList();
            }
        }
        if (changes.team) {
            const prev = state.team;
            state.team = changes.team.newValue || null;
            renderTeam();
            if (!prev || !state.team || prev.status !== state.team.status || prev.memberId !== state.team.memberId
                || prev.categoryId !== state.team.categoryId) {
                state.channel = null;
                state.messages = [];
                start();
            }
        }
    });
})();
