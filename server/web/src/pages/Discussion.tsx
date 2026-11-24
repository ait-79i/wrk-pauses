// Discussion : fil de messages d'une catégorie (ou des admins de l'équipe), vu depuis le tableau de bord.
// Les publications d'horaires y apparaissent sous la même forme de carte que l'onglet Horaires du jour.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
    deleteMessage, formatDay, formatTime, listChannels, listMessages, minsToHHMM, postMessage,
    PRAYER_ARABIC, PRAYER_LABEL, type MessageDTO, type TeamDetail
} from '../api';
import { useRealtime, useRealtimeStatus } from '../realtime';
import { FormDialog, Loading, useAction, useData } from '../ui';

const MAX_LENGTH = 2000;

// ------------------------------------------------------------------ Outils

const byId = (a: MessageDTO, b: MessageDTO) => a.id - b.id;

/** Fusionne deux listes de messages (la plus récente version de chaque id l'emporte) */
function merge(current: MessageDTO[], incoming: MessageDTO[]): MessageDTO[] {
    const map = new Map(current.map((m) => [m.id, m]));
    for (const m of incoming) map.set(m.id, m);
    return [...map.values()].sort(byId);
}

/** Minuscule sans accent, caractère par caractère (garde les positions du texte d'origine) */
function foldChars(text: string): string {
    let out = '';
    for (let i = 0; i < text.length; i++) {
        const f = text[i].normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
        out += f.length === 1 ? f : text[i];
    }
    return out;
}

/** Corps du message en texte brut, mentions (@Nom) mises en évidence */
/** Extrait sur une ligne : « @Nom » isolé pour rester d'un bloc dans un texte mêlant arabe et français */
function isolateMentions(text: string): ReactNode[] {
    const out: ReactNode[] = [];
    let last = 0;
    for (const match of text.matchAll(/@[\p{L}\p{M}\p{N}._'-]+/gu)) {
        const at = match.index ?? 0;
        if (at > last) out.push(text.slice(last, at));
        out.push(<bdi key={at} className="msg-mention-inline">{match[0]}</bdi>);
        last = at + match[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
}

function renderBody(body: string, mentions: MessageDTO['mentions']): ReactNode[] {
    if (mentions.length === 0) return [body];
    const folded = foldChars(body);
    const names = [...new Set(mentions.map((m) => foldChars(m.name)))].sort((a, b) => b.length - a.length);
    const out: ReactNode[] = [];
    let last = 0;
    for (let i = 0; i < body.length; i++) {
        if (body[i] !== '@') continue;
        const name = names.find((n) => folded.startsWith(n, i + 1));
        if (!name) continue;
        if (i > last) out.push(body.slice(last, i));
        out.push(<mark key={i} className="mention" dir="auto">{body.slice(i, i + 1 + name.length)}</mark>);
        last = i + 1 + name.length;
        i = last - 1;
    }
    if (last < body.length) out.push(body.slice(last));
    return out;
}

const dayKey = (iso: string) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ------------------------------------------------------------------ Onglet

export function DiscussionTab({ team }: { team: TeamDetail }) {
    const channels = useData(() => listChannels(team.id), [team.id]);
    const list = channels.data?.channels ?? [];
    const [channel, setChannel] = useState<string | null>(null);
    const [fresh, setFresh] = useState<Record<string, number>>({});
    const current = list.find((c) => c.key === channel) ?? list[0];

    useRealtime((e) => {
        if (e.type !== 'message.created') return;
        const key = e.message.channel;
        if (key === current?.key || !list.some((c) => c.key === key)) return;
        setFresh((f) => ({ ...f, [key]: (f[key] ?? 0) + 1 }));
    });

    if (!channels.data) return <Loading error={channels.error} />;
    if (!current) {
        return (
            <div className="empty">
                <strong>Aucune discussion visible</strong>
                Chaque catégorie a sa discussion. Créez une catégorie dans l'onglet Catégories et groupes.
            </div>
        );
    }

    return (
        <div className="stack">
            <div className="day-picker" role="group" aria-label="Discussion">
                {list.map((c) => (
                    <button
                        key={c.key}
                        className="day-chip"
                        aria-pressed={c.key === current.key}
                        title={`${c.messages7d} message${c.messages7d > 1 ? 's' : ''} ces 7 derniers jours`}
                        onClick={() => {
                            setChannel(c.key);
                            setFresh((f) => ({ ...f, [c.key]: 0 }));
                        }}
                    >
                        {c.name}
                        {(fresh[c.key] ?? 0) > 0 && <span className="chip-count">{fresh[c.key]}</span>}
                    </button>
                ))}
            </div>
            <ChannelView key={current.key} team={team} channelKey={current.key} channelName={current.name} />
        </div>
    );
}

// ------------------------------------------------------------------ Fil d'un canal

type ScrollIntent = { kind: 'bottom' } | { kind: 'keep'; height: number; top: number } | null;

function ChannelView({ team, channelKey, channelName }: { team: TeamDetail; channelKey: string; channelName: string }) {
    const { run, busy } = useAction();
    const status = useRealtimeStatus();
    const [messages, setMessages] = useState<MessageDTO[] | null>(null);
    const [hasMore, setHasMore] = useState(false);
    const [loadingOlder, setLoadingOlder] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [replyTo, setReplyTo] = useState<MessageDTO | null>(null);
    const [toDelete, setToDelete] = useState<MessageDTO | null>(null);
    const [flash, setFlash] = useState<number | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [spoken, setSpoken] = useState('');
    const scroller = useRef<HTMLDivElement>(null);
    const intent = useRef<ScrollIntent>({ kind: 'bottom' });
    const loaded = useRef(false);

    // Droits côté interface (le serveur reste seul juge)
    const categoryId = channelKey.startsWith('cat:') ? Number(channelKey.slice(4)) : null;
    const category = team.categories.find((c) => c.id === categoryId);
    const canAnnounce = team.canManageTeam || Boolean(category?.canPublish);
    const canModerate = team.canManageTeam || Boolean(category?.canManage);
    const groupNames = useMemo(
        () => new Map(team.categories.flatMap((c) => c.groups.map((g) => [g.id, g.name] as const))),
        [team.categories]
    );

    const nearBottom = () => {
        const el = scroller.current;
        return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    };

    const loadLatest = useCallback(async () => {
        try {
            const page = await listMessages(channelKey);
            if (!loaded.current) {
                // Premier chargement : la pagination part de cette page
                loaded.current = true;
                intent.current = { kind: 'bottom' };
                setHasMore(page.hasMore);
            } else if (nearBottom()) {
                intent.current = { kind: 'bottom' };
            }
            setMessages((cur) => merge(cur ?? [], page.messages));
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Chargement impossible.');
        }
    }, [channelKey]);

    useEffect(() => { void loadLatest(); }, [loadLatest]);

    useRealtime((e) => {
        if (e.type === 'ready') {
            // Reconnexion : rattrape les messages manqués
            if (loaded.current) void loadLatest();
            return;
        }
        if ((e.type !== 'message.created' && e.type !== 'message.updated') || e.message.channel !== channelKey) return;
        if (e.type === 'message.created' && nearBottom()) intent.current = { kind: 'bottom' };
        if (e.type === 'message.created') {
            // Annonce polie, sans relire toute la liste
            const m = e.message;
            setSpoken(m.kind === 'SCHEDULE' ? 'Nouveaux horaires publiés' : `${m.kind === 'ANNOUNCEMENT' ? 'Annonce' : 'Nouveau message'} de ${m.author.name}`);
        }
        setMessages((cur) => (cur ? merge(cur, [e.message]) : cur));
    });

    useLayoutEffect(() => {
        const el = scroller.current;
        const i = intent.current;
        if (!el || !i) return;
        if (i.kind === 'bottom') el.scrollTop = el.scrollHeight;
        else el.scrollTop = el.scrollHeight - i.height + i.top;
        intent.current = null;
    }, [messages]);

    async function loadOlder() {
        if (!messages?.length) return;
        setLoadingOlder(true);
        try {
            const page = await listMessages(channelKey, messages[0].id);
            const el = scroller.current;
            if (el) intent.current = { kind: 'keep', height: el.scrollHeight, top: el.scrollTop };
            setMessages((cur) => merge(cur ?? [], page.messages));
            setHasMore(page.hasMore);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Chargement impossible.');
        } finally {
            setLoadingOlder(false);
        }
    }

    function jumpTo(id: number) {
        const el = document.getElementById(`msg-${id}`);
        if (!el) {
            setNotice('Le message d\'origine est plus ancien : chargez les messages précédents.');
            setTimeout(() => setNotice(null), 6000);
            return;
        }
        setNotice(null);
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setFlash(id);
        setTimeout(() => setFlash((f) => (f === id ? null : f)), 1600);
    }

    async function send(body: string, announce: boolean): Promise<boolean> {
        const m = await run(() => postMessage({
            channel: channelKey,
            body,
            kind: announce ? 'ANNOUNCEMENT' : 'TEXT',
            replyToId: replyTo?.id
        }), announce ? 'Annonce publiée' : undefined);
        if (!m) return false;
        intent.current = { kind: 'bottom' };
        setMessages((cur) => merge(cur ?? [], [m]));
        setReplyTo(null);
        return true;
    }

    // Regroupe les messages par jour
    const days: { key: string; items: MessageDTO[] }[] = [];
    for (const m of messages ?? []) {
        const k = dayKey(m.createdAt);
        if (days.at(-1)?.key !== k) days.push({ key: k, items: [] });
        days.at(-1)!.items.push(m);
    }

    return (
        <div className="panel chat">
            <div className="chat-head">
                <h2>{channelName}</h2>
                {status !== 'open' && (
                    <span className="badge badge-wait" title="Les nouveaux messages s'afficheront à la reconnexion">
                        {status === 'connecting' ? 'Connexion…' : 'Hors ligne, reconnexion automatique'}
                    </span>
                )}
            </div>

            <p className="sr-only" aria-live="polite" aria-atomic="true">{spoken}</p>
            {notice && <p className="muted small chat-notice" role="status">{notice}</p>}

            <div className="chat-scroll" ref={scroller}>
                {!messages ? <Loading error={error} /> : messages.length === 0 ? (
                    <div className="empty chat-empty">
                        <strong>Aucun message dans cette discussion</strong>
                        {channelKey.startsWith('admins:')
                            ? 'Écrivez ci-dessous : seuls les admins et responsables de l\'équipe lisent cette discussion.'
                            : 'Écrivez le premier message ci-dessous. Les horaires publiés apparaissent aussi ici.'}
                    </div>
                ) : (
                    <>
                        {hasMore && (
                            <div className="chat-more">
                                <button className="btn btn-ghost btn-small" onClick={loadOlder} disabled={loadingOlder}>
                                    {loadingOlder ? 'Chargement…' : 'Afficher les messages précédents'}
                                </button>
                            </div>
                        )}
                        {error && <p className="form-error" role="alert">{error}</p>}
                        {days.map((d) => (
                            <section key={d.key} className="chat-day" aria-label={formatDay(d.key)}>
                                <div className="chat-day-label"><span>{formatDay(d.key)}</span></div>
                                {d.items.map((m) => (
                                    <MessageItem
                                        key={m.id}
                                        message={m}
                                        groupNames={groupNames}
                                        flash={flash === m.id}
                                        canModerate={canModerate}
                                        onReply={() => setReplyTo(m)}
                                        onDelete={() => setToDelete(m)}
                                        onJump={jumpTo}
                                    />
                                ))}
                            </section>
                        ))}
                    </>
                )}
            </div>

            <Composer
                key={channelKey}
                canAnnounce={canAnnounce}
                busy={busy}
                replyTo={replyTo}
                onCancelReply={() => setReplyTo(null)}
                onSend={send}
            />

            <FormDialog
                open={toDelete !== null}
                danger
                title="Supprimer ce message ?"
                submitLabel="Supprimer"
                onClose={() => setToDelete(null)}
                onSubmit={async () => {
                    const target = toDelete!;
                    const ok = await run(() => deleteMessage(target.id), 'Message supprimé');
                    if (!ok) return false;
                    setMessages((cur) => (cur ? merge(cur, [{ ...target, deleted: true, body: '', reactions: [] }]) : cur));
                    // Le bouton Supprimer n'existe plus : le focus va sur le message, après la fermeture du dialogue
                    setTimeout(() => document.getElementById(`msg-${target.id}`)?.focus(), 50);
                }}
            >
                <p>
                    {toDelete?.kind === 'SCHEDULE'
                        ? 'La carte d\'horaires disparaît de la discussion. Les horaires publiés restent valables.'
                        : `Le message de ${toDelete?.author.name ?? ''} sera remplacé par « Message supprimé » pour tous. L'action est notée dans le journal d'activité.`}
                </p>
                {toDelete && toDelete.kind !== 'SCHEDULE' && <blockquote className="msg-quote" dir="auto">{toDelete.body.slice(0, 160)}</blockquote>}
            </FormDialog>
        </div>
    );
}

// ------------------------------------------------------------------ Message

function MessageItem({ message: m, groupNames, flash, canModerate, onReply, onDelete, onJump }: {
    message: MessageDTO; groupNames: Map<number, string>; flash: boolean; canModerate: boolean;
    onReply: () => void; onDelete: () => void; onJump: (id: number) => void;
}) {
    const announce = m.kind === 'ANNOUNCEMENT';
    const cls = ['msg', announce && 'msg-announce', m.kind === 'SCHEDULE' && 'msg-system', m.deleted && 'is-deleted', flash && 'is-flash']
        .filter(Boolean).join(' ');

    return (
        <article id={`msg-${m.id}`} className={cls} aria-label={`Message de ${m.author.name}`} tabIndex={-1}>
            <div className="msg-meta">
                {announce && <span className="msg-label">Annonce</span>}
                <span className="msg-author" dir="auto">{m.author.name}</span>
                {m.author.type === 'admin' && <span className="badge badge-role">Admin</span>}
                <time className="muted small" dateTime={m.createdAt}>{formatTime(m.createdAt)}</time>
                {!m.deleted && (
                    <span className="msg-actions">
                        {m.kind !== 'SCHEDULE' && <button className="btn-link small" onClick={onReply}>Répondre</button>}
                        {canModerate && <button className="btn-link btn-link-danger small" onClick={onDelete}>Supprimer</button>}
                    </span>
                )}
            </div>

            {m.deleted ? <p className="msg-deleted">Message supprimé</p> : (
                <>
                    {m.replyTo && (
                        <button className="msg-quote" onClick={() => onJump(m.replyTo!.id)} title="Voir le message d'origine">
                            <span className="msg-quote-author" dir="auto">{m.replyTo.authorName}</span>
                            <span className="msg-quote-text" dir="auto">{isolateMentions(m.replyTo.excerpt)}</span>
                        </button>
                    )}
                    {m.kind === 'SCHEDULE' && m.schedule
                        ? <ScheduleCard schedule={m.schedule} groupNames={groupNames} />
                        : <p className="msg-body" dir="auto">{renderBody(m.body, m.mentions)}</p>}
                    {m.reactions.length > 0 && (
                        <div className="reactions" aria-label="Réactions">
                            {m.reactions.map((r) => (
                                <span key={r.emoji} className="reaction" title={`${r.count} réaction${r.count > 1 ? 's' : ''}`}>
                                    <span aria-hidden="true">{r.emoji}</span> {r.count}
                                </span>
                            ))}
                        </div>
                    )}
                </>
            )}
        </article>
    );
}

function ScheduleCard({ schedule: s, groupNames }: { schedule: NonNullable<MessageDTO['schedule']>; groupNames: Map<number, string> }) {
    const updated = s.change === 'updated';
    const removed = s.removedGroupIds.map((id) => groupNames.get(id) ?? `Groupe ${id}`);
    return (
        <section className="prayer-card is-published msg-schedule" aria-label={`Horaires ${PRAYER_LABEL[s.prayer]}`}>
            <header className="prayer-card-head">
                <div>
                    <div className="prayer-arabic" lang="ar" dir="rtl">{PRAYER_ARABIC[s.prayer]}</div>
                    <div className="prayer-latin">{PRAYER_LABEL[s.prayer]}, {formatDay(s.date)}</div>
                </div>
                <span className="badge badge-live">{updated ? 'Mis à jour' : 'Publié'}</span>
            </header>
            <div className="slot-list">
                {s.slots.map((slot) => {
                    const moved = updated && slot.groupId !== null && s.movedGroupIds.includes(slot.groupId);
                    const added = updated && slot.groupId !== null && (s.addedGroupIds ?? []).includes(slot.groupId);
                    return (
                        <div key={slot.groupId ?? 'jumua'} className={`slot${moved || added ? ' is-moved' : ''}`}>
                            <span className="slot-name">{slot.groupName ?? 'Jumu\'a'}</span>
                            <span className="slot-time-text">{minsToHHMM(slot.timeMins)}</span>
                            <span className="slot-count">
                                {moved && <span className="slot-count-pill">déplacé</span>}
                                {added && <span className="slot-count-pill">ajouté</span>}
                            </span>
                        </div>
                    );
                })}
            </div>
            {removed.length > 0 && (
                <p className="prayer-card-foot muted small">
                    {removed.length > 1 ? `Groupes retirés : ${removed.join(', ')}` : `Groupe retiré : ${removed[0]}`}
                </p>
            )}
        </section>
    );
}

// ------------------------------------------------------------------ Saisie

function Composer({ canAnnounce, busy, replyTo, onCancelReply, onSend }: {
    canAnnounce: boolean; busy: boolean; replyTo: MessageDTO | null;
    onCancelReply: () => void; onSend: (body: string, announce: boolean) => Promise<boolean>;
}) {
    const [text, setText] = useState('');
    const [announce, setAnnounce] = useState(false);
    const area = useRef<HTMLTextAreaElement>(null);
    const body = text.trim();

    useEffect(() => { if (replyTo) area.current?.focus(); }, [replyTo]);

    async function submit() {
        if (!body || busy) return;
        if (await onSend(body, announce)) {
            setText('');
            setAnnounce(false);
            area.current?.focus();
        }
    }

    return (
        <form
            className={`composer${announce ? ' is-announce' : ''}`}
            onSubmit={(e) => { e.preventDefault(); void submit(); }}
        >
            {replyTo && (
                <div className="composer-reply">
                    <span className="small">
                        Réponse à <strong dir="auto">{replyTo.author.name}</strong>
                        {' '}<span className="muted msg-quote-text" dir="auto">{isolateMentions(replyTo.body.slice(0, 80))}</span>
                    </span>
                    <button type="button" className="btn-link small" onClick={onCancelReply}>Annuler</button>
                </div>
            )}
            <textarea
                ref={area}
                className="input composer-input"
                dir="auto"
                rows={2}
                maxLength={MAX_LENGTH}
                placeholder={announce ? 'Texte de l\'annonce, notifiée à tous les membres' : 'Écrire un message. @Prénom pour mentionner un membre'}
                aria-label="Message"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        void submit();
                    }
                }}
            />
            <div className="composer-foot">
                {canAnnounce && (
                    <label className="check small">
                        <input type="checkbox" checked={announce} onChange={(e) => setAnnounce(e.target.checked)} />
                        Publier comme annonce
                    </label>
                )}
                <span className="spacer" />
                {text.length > MAX_LENGTH - 200 && <span className="muted small">{MAX_LENGTH - text.length} caractères restants</span>}
                <span className="muted small composer-hint">Entrée pour envoyer, Maj+Entrée pour aller à la ligne</span>
                <button className="btn btn-primary" disabled={!body || busy}>{announce ? 'Publier l\'annonce' : 'Envoyer'}</button>
            </div>
        </form>
    );
}
