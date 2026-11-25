// Panneau « Prière en groupe » de la fenêtre principale (application Windows uniquement).
// Rejoindre une équipe, voir les horaires du jour, choisir son groupe, publier les horaires
// (admins et responsables horaires) et ouvrir la discussion. Vocabulaire : GLOSSARY.md.
// Dépend de salat-core.js (pad2) ; données lues dans chrome.storage (team, teamDay, teamError, teamUnread),
// actions via window.psTeam (processus principal).

(function () {
    const root = document.getElementById('teamPanel');
    if (!root || !window.psTeam) return;
    root.hidden = false;

    const ARABIC = { DHUHR: 'صلاة الظهر', ASR: 'صلاة العصر', JUMUA: 'صلاة الجمعة' };
    const LATIN = { DHUHR: 'Dhuhr', ASR: 'Asr', JUMUA: 'Jumu\'a' };

    const KEYS = ['team', 'teamDay', 'teamError', 'teamUnread'];
    let state = { team: null, teamDay: null, teamError: null, teamUnread: 0 };
    let view = 'idle'; // idle | join | transfer
    let editing = null; // prière dont le formulaire de publication est ouvert
    let busy = false;
    let flash = null; // message d'erreur de la dernière action

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

    async function act(fn) {
        busy = true;
        flash = null;
        render();
        const res = await fn();
        busy = false;
        if (!res.ok) flash = res.message;
        render();
        return res.ok;
    }

    // ---------------------------------------------------------------- Rejoindre

    function renderJoin() {
        const isTransfer = view === 'transfer';
        const form = el('form', { class: 'team-form', novalidate: true });
        const code = el('input', {
            class: 'team-input team-input--code', name: 'code', required: true, maxlength: '9',
            autocomplete: 'off', spellcheck: 'false', placeholder: 'ABC-123',
            'aria-label': isTransfer ? 'Code de transfert' : 'Code d\'accès de l\'équipe'
        });
        const name = isTransfer ? null : el('input', {
            class: 'team-input', name: 'name', required: true, maxlength: '60', autocomplete: 'name',
            placeholder: 'Votre prénom', 'aria-label': 'Votre prénom, tel que vos collègues le connaissent'
        });
        form.append(
            el('p', { class: 'team-muted' }, isTransfer
                ? 'Saisissez le code de transfert donné par l\'admin pour retrouver votre compte.'
                : 'Saisissez le code d\'accès donné par l\'admin de votre équipe.'),
            el('div', { class: 'team-form-row' }, code, name,
                el('button', { class: 'team-btn team-btn--primary', type: 'submit', disabled: busy }, isTransfer ? 'Valider' : 'Rejoindre')),
            el('div', { class: 'team-form-links' },
                el('button', { type: 'button', class: 'team-link', onclick: () => { view = isTransfer ? 'join' : 'transfer'; flash = null; render(); } },
                    isTransfer ? 'J\'ai un code d\'accès' : 'J\'ai un code de transfert'),
                el('button', { type: 'button', class: 'team-link', onclick: () => { view = 'idle'; flash = null; render(); } }, 'Annuler'))
        );
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const c = code.value.trim();
            const n = name ? name.value.trim() : '';
            if (c.length < 4) { flash = 'Saisissez le code complet.'; render(); return; }
            if (name && n.length < 2) { flash = 'Saisissez votre prénom.'; render(); return; }
            const ok = await act(() => (isTransfer ? window.psTeam.transfer(c) : window.psTeam.join(c, n)));
            if (ok) { view = 'idle'; render(); }
        });
        setTimeout(() => code.focus(), 0);
        return form;
    }

    // ---------------------------------------------------------------- Publication (admins, responsables horaires)

    function renderPublishForm(p, day) {
        const isJumua = p.prayer === 'JUMUA';
        const timeOf = (groupId) => {
            const slot = p.slots.find((s) => s.groupId === groupId);
            return slot ? hhmm(slot.timeMins) : '';
        };
        const rows = isJumua
            ? [{ groupId: null, label: 'Jumu\'a', value: timeOf(null) }]
            : day.groups.map((g) => ({ groupId: g.id, label: g.name, value: timeOf(g.id) }));
        const inputs = rows.map((r) => el('input', {
            type: 'time', class: 'team-input team-input--time', value: r.value, 'data-group': r.groupId === null ? '' : String(r.groupId),
            'aria-label': isJumua ? 'Heure de Jumu\'a' : `Heure du groupe ${r.label}`
        }));
        const form = el('form', { class: 'team-publish', novalidate: true },
            el('div', { class: 'team-publish-grid' }, rows.map((r, i) => el('label', { class: 'team-publish-field' },
                el('span', { class: 'team-publish-label' }, r.label), inputs[i]))),
            isJumua ? null : el('p', { class: 'team-muted' }, 'Laissez vide un groupe qui ne prie pas ensemble ce jour-là.'),
            el('div', { class: 'team-publish-actions' },
                el('button', { type: 'button', class: 'team-link', disabled: busy, onclick: () => { editing = null; flash = null; render(); } }, 'Annuler'),
                el('button', { type: 'submit', class: 'team-btn team-btn--primary', disabled: busy }, p.published ? 'Mettre à jour' : 'Publier')));
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const slots = inputs.filter((i) => i.value).map((i) => ({
                groupId: i.dataset.group ? Number(i.dataset.group) : null, time: i.value.slice(0, 5)
            }));
            if (!slots.length) {
                flash = isJumua ? 'Indiquez l\'heure de Jumu\'a.' : 'Indiquez l\'heure d\'au moins un groupe.';
                render();
                return;
            }
            const ok = await act(() => window.psTeam.publish(day.date, p.prayer, slots));
            if (ok) { editing = null; render(); }
        });
        setTimeout(() => (inputs.find((i) => !i.value) || inputs[0])?.focus(), 0);
        return form;
    }

    // ---------------------------------------------------------------- Horaires du jour

    function renderPrayer(p, day) {
        const canPublish = Boolean(state.team && state.team.canPublish && window.psTeam.publish);
        const startEdit = () => { editing = p.prayer; flash = null; render(); };
        const head = el('div', { class: 'team-prayer-head' },
            el('span', { class: 'team-prayer-ar', lang: 'ar', dir: 'rtl' }, ARABIC[p.prayer]),
            el('span', { class: 'team-prayer-latin' }, LATIN[p.prayer]),
            canPublish && p.published && editing !== p.prayer
                ? el('button', { type: 'button', class: 'team-link team-prayer-edit', disabled: busy || editing !== null, onclick: startEdit },
                    'Modifier les horaires')
                : null);

        if (editing === p.prayer) {
            return el('div', { class: 'team-prayer' }, head, renderPublishForm(p, day));
        }
        if (!p.published) {
            if (canPublish) {
                return el('div', { class: 'team-prayer' }, head, el('div', { class: 'team-notice team-notice--action' },
                    el('span', {}, 'Horaires pas encore publiés. Les membres attendent pour choisir leur groupe.'),
                    el('button', { type: 'button', class: 'team-btn team-btn--primary', disabled: busy || editing !== null, onclick: startEdit },
                        'Publier')));
            }
            return el('div', { class: 'team-prayer' }, head, el('span', { class: 'team-muted' }, 'Horaires pas encore publiés'));
        }
        if (p.prayer === 'JUMUA') {
            return el('div', { class: 'team-prayer' }, head,
                el('span', { class: 'team-jumua' }, `Jumu'a à ${hhmm(p.slots[0].timeMins)}`));
        }

        const isToday = day.date === day.today;
        const mine = p.slots.find((s) => s.groupId === p.myGroupId);
        // Le choix est figé une fois l'heure de son groupe passée
        const locked = Boolean(isToday && mine && mine.timeMins <= day.nowMins);
        const chips = p.slots.map((s) => {
            const past = isToday && s.timeMins <= day.nowMins;
            const selected = s.groupId === p.myGroupId;
            return el('button', {
                type: 'button',
                class: `team-chip${selected ? ' is-selected' : ''}`,
                'aria-pressed': String(selected),
                disabled: busy || past || locked,
                title: `${s.count} membre${s.count > 1 ? 's' : ''} avec ${s.groupName}`,
                onclick: () => act(() => window.psTeam.choose(day.date, p.prayer, selected ? null : s.groupId))
            },
            el('strong', {}, s.groupName), ` ${hhmm(s.timeMins)}`,
            el('span', { class: 'team-chip-count' }, String(s.count)));
        });

        let footer = null;
        if (mine && !locked) {
            const usual = p.usualGroupId === p.myGroupId;
            footer = el('div', { class: 'team-prayer-foot' },
                el('span', { class: 'team-muted' }, usual ? `${mine.groupName} est votre groupe habituel.` : 'Rappel 5 min avant.'),
                el('button', {
                    type: 'button', class: 'team-link', disabled: busy,
                    onclick: () => act(() => window.psTeam.setUsual(p.prayer, usual ? null : p.myGroupId))
                }, usual ? 'Ne plus le retenir' : `Choisir ${mine.groupName} chaque jour`));
        } else if (!mine) {
            footer = el('span', { class: 'team-muted' }, 'Choisissez un groupe pour recevoir son rappel.');
        }

        return el('div', { class: 'team-prayer' }, head, el('div', { class: 'team-chips' }, chips), footer);
    }

    // ---------------------------------------------------------------- Code à partager

    /** Copie dans le presse-papiers (API moderne, sinon sélection + copie) */
    async function copyText(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            const area = el('textarea', { 'aria-hidden': 'true', style: 'position:fixed;opacity:0' });
            area.value = text;
            document.body.append(area);
            area.select();
            const ok = document.execCommand('copy');
            area.remove();
            return ok;
        }
    }

    /** Code d'accès de la catégorie, pour que le membre invite ses collègues */
    function renderShareCode(team) {
        const until = team.accessCodeExpiresAt
            ? ` (valable jusqu'au ${new Date(team.accessCodeExpiresAt).toLocaleDateString('fr-FR')})`
            : '';
        const btn = el('button', {
            type: 'button', class: 'team-link team-code-copy',
            'aria-label': `Copier le code d'accès ${team.accessCode}`
        }, 'Copier');
        btn.addEventListener('click', async () => {
            const ok = await copyText(team.accessCode);
            btn.textContent = ok ? 'Copié' : 'Copie impossible';
            setTimeout(() => { btn.textContent = 'Copier'; }, 2000);
        });
        return el('span', {
            class: 'team-code',
            title: `Donnez ce code à vos collègues : ils le saisissent dans Pause pour rejoindre ${team.categoryName}${until}.`
        }, el('span', { class: 'team-code-label' }, 'Code'), el('span', { class: 'team-code-value' }, team.accessCode), btn);
    }

    // ---------------------------------------------------------------- Rendu

    function render() {
        const { team, teamDay, teamError } = state;
        root.replaceChildren();

        if (!team) {
            if (view === 'idle') {
                root.append(el('div', { class: 'team-invite' },
                    el('div', {},
                        el('p', { class: 'team-title' }, 'Prière en groupe'),
                        el('p', { class: 'team-muted' }, 'Rejoignez votre équipe pour choisir votre groupe chaque jour.')),
                    el('button', { type: 'button', class: 'team-btn', onclick: () => { view = 'join'; render(); } }, 'Rejoindre')));
            } else {
                root.append(el('p', { class: 'team-title' }, 'Rejoindre une équipe'), renderJoin());
            }
        } else {
            const unread = Number(state.teamUnread) || 0;
            root.append(el('div', { class: 'team-header' },
                el('div', { class: 'team-header-text' },
                    el('p', { class: 'team-title' }, `${team.categoryName}, ${team.teamName}`),
                    el('div', { class: 'team-who' },
                        el('span', { class: 'team-muted' }, team.memberName),
                        team.status === 'ACTIVE' && team.accessCode ? renderShareCode(team) : null)),
                team.status === 'ACTIVE' && window.psTeam.openChat
                    ? el('button', {
                        type: 'button', class: 'team-btn team-chat-btn', onclick: () => window.psTeam.openChat(),
                        'aria-label': unread ? `Discussion, ${unread} message${unread > 1 ? 's' : ''} non lu${unread > 1 ? 's' : ''}` : 'Discussion'
                    }, 'Discussion', unread ? el('span', { class: 'team-badge', 'aria-hidden': 'true' }, unread > 99 ? '99+' : String(unread)) : null)
                    : null));

            if (team.status === 'PENDING') {
                root.append(el('p', { class: 'team-notice' }, 'Votre demande est envoyée. Un admin de l\'équipe doit la valider.'));
            } else if (team.status === 'BLOCKED') {
                root.append(el('p', { class: 'team-notice' }, 'Votre accès à l\'équipe est suspendu. Contactez un admin.'));
            } else if (!teamDay) {
                root.append(el('p', { class: 'team-muted' }, teamError || 'Chargement des horaires…'));
            } else if (!teamDay.isWorkday || teamDay.prayers.length === 0) {
                root.append(el('p', { class: 'team-muted' }, 'Pas de prière en groupe aujourd\'hui.'));
            } else {
                root.append(el('div', { class: 'team-prayers' }, teamDay.prayers.map((p) => renderPrayer(p, teamDay))));
            }
            if (teamError && teamDay) {
                root.append(el('p', { class: 'team-muted' }, `${teamError} Les derniers horaires reçus restent utilisés pour le rappel.`));
            }
        }
        if (flash) root.append(el('p', { class: 'team-error', role: 'alert' }, flash));
    }

    chrome.storage.local.get(KEYS, (res) => {
        state = { team: res.team || null, teamDay: res.teamDay || null, teamError: res.teamError || null, teamUnread: res.teamUnread || 0 };
        render();
    });

    chrome.storage.onChanged.addListener((changes) => {
        let changed = false;
        for (const k of KEYS) {
            if (changes[k]) { state[k] = changes[k].newValue || (k === 'teamUnread' ? 0 : null); changed = true; }
        }
        // Pas de re-rendu pendant une saisie (adhésion, publication des horaires)
        if (changed && !busy && view === 'idle' && editing === null) render();
    });

    // Fenêtre réaffichée : horaires à jour
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && state.team) window.psTeam.refresh();
    });
})();
