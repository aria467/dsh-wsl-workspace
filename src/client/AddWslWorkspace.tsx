/**
 * Sidebar footer action that opens the "Add WSL workspace" dialog. In the
 * wide sidebar it renders a labeled row; in the 56px rail it collapses to a
 * 36px icon button (both honor the shell's `{ wide }` owner share).
 *
 * Registration omits the typed `locale:` seat (the `wslWorkspace` namespace is
 * not merged into `LocaleNamespaceMap`), so the injected face carries the
 * bound translate function instead.
 */

import type * as React from 'react'
import { Fragment, useEffect, useRef, useState, type UIEventHandler } from 'react'
import { isAbsoluteLinuxPath, isValidWslUsername, normalizeLinuxPath } from '../shared/paths.ts'
import type { WslDirListing, WslPathCheck, WslSelfDescription } from './api.ts'
import { WslHelp } from './help.tsx'

/** Result-level shape of a browse/check/list call we surface uniformly. */
interface ApiCall<T> {
  value: T
}

/** The inject face: plain data + callbacks the dialog drives. */
export interface AddWslWorkspaceInjected {
  /**
   * Confirm the deployment exposes a healthy `wsl` preset.
   * @returns undefined when healthy, else a Chinese/English message to show.
   */
  checkPreset(): Promise<string | undefined>
  /**
   * Read this build's version and its declared DSH compatibility matrix,
   * for the help panel. A host that cannot answer resolves to a fallback
   * description rather than failing the dialog.
   */
  describe(): Promise<WslSelfDescription>
  /** List the WSL distros installed on the host. */
  listDistros(): Promise<string[]>
  /** List one Linux directory level inside a distro. */
  listDir(distro: string, path: string): Promise<WslDirListing>
  /** Check a Linux path's existence/directory facts. */
  check(distro: string, path: string): Promise<WslPathCheck>
  /**
   * Register a WSL workspace and start a session in it. `/mnt/<drive>`
   * paths register under their Windows drive spelling (9P cannot serve
   * drvfs); ext4 paths register as `\\wsl.localhost\<distro>\...` UNC.
   * @param linuxPath - the absolute Linux workspace path.
   * @param username - optional Linux user for the session (empty = distro default).
   * @param distro - the WSL distribution the path belongs to.
   * @returns undefined on success, else a message to show.
   */
  createWorkspace(linuxPath: string, username: string, distro: string): Promise<string | undefined>
  /** Translate a `wslWorkspace` dictionary key (follows the DeepSeek Harness locale). */
  t: (key: string, params?: Record<string, unknown>) => string
}

/** Full component props: the owner share plus the injected face. */
export interface AddWslWorkspaceProps extends AddWslWorkspaceInjected {
  /** Whether the sidebar renders wide content (false = 56px rail). */
  wide: boolean
}

/**
 * Build the Linux child path one level below a parent, for the breadcrumb/
 * browse drill.
 * @param parent - the currently listed absolute path (`/` for root).
 * @param name - the child directory name.
 * @returns the child's absolute Linux path.
 */
export function dirChildPath(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`
}

/**
 * Split an absolute Linux path into clickable breadcrumb segments, each with
 * the path it navigates to. The root is its own crumb, so a deep path can be
 * walked back one level at a time without using the tree.
 * @param path - an absolute Linux path (`/`, `/home`, `/home/me/proj`).
 * @returns one entry per segment, root first.
 */
export function pathSegments(path: string): { label: string; path: string }[] {
  const segments = path.split('/').filter(segment => segment !== '')
  const result: { label: string; path: string }[] = [{ label: '/', path: '/' }]
  let current = ''
  for (const segment of segments) {
    current += `/${segment}`
    result.push({ label: segment, path: current })
  }
  return result
}

/**
 * The quick-start paths offered beside the browse box: where a WSL workspace
 * usually lives. Clicking one browses it; a path the distribution does not
 * mount answers with the ordinary browse error rather than a silent no-op.
 */
const QUICK_PATHS: { label: string; path: string }[] = [
  { label: '/', path: '/' },
  { label: '/home', path: '/home' },
  { label: '/tmp', path: '/tmp' },
  { label: '/mnt/c', path: '/mnt/c' },
]

/** How the path box's inline check reads: nothing, in flight, usable, rejected. */
type PathStatus = 'idle' | 'checking' | 'ok' | 'invalid'

/** A tiny inline terminal glyph for the dialog's directory rows. */
function WslGlyph({ size = 16 }: { size?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2.5" y="4.5" width="19" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M6 9l3.2 2.6L6 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 14h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

/**
 * The "Add WSL workspace…" footer action and its dialog.
 * @param props - owner share + injected face.
 */
export function AddWslWorkspace({ wide, t, describe, checkPreset, listDistros, listDir, check, createWorkspace }: AddWslWorkspaceProps): React.ReactElement | null {
  const [open, setOpen] = useState(false)
  const [opening, setOpening] = useState(false)
  const [distros, setDistros] = useState<string[]>([])
  const [distro, setDistro] = useState('')
  const [pathInput, setPathInput] = useState('/home/')
  const [username, setUsername] = useState('')
  const [listing, setListing] = useState<WslDirListing | null>(null)
  const [browsePath, setBrowsePath] = useState('/')
  const [browsing, setBrowsing] = useState(false)
  const [browseFailed, setBrowseFailed] = useState(false)
  const [pathStatus, setPathStatus] = useState<PathStatus>('idle')
  const [pathNote, setPathNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // The "?" panel: help text plus the compatibility list the host reports.
  const [helpOpen, setHelpOpen] = useState(false)
  const [selfDescription, setSelfDescription] = useState<WslSelfDescription | null>(null)
  // Monotone browse-request sequence: stale responses for a superseded browse are dropped.
  const browseSeq = useRef(0)

  const refreshBrowse = async (root: string, targetDistro: string): Promise<void> => {
    const seq = ++browseSeq.current
    setBrowsing(true)
    setBrowsePath(root)
    try {
      const value = await listDir(targetDistro, root)
      if (seq === browseSeq.current) {
        setListing(value)
        setBrowseFailed(false)
      }
    } catch {
      // A failed browse (permission, missing dir) is non-fatal: drop the stale
      // listing and let the browse box say why instead of pretending the level
      // is empty.
      if (seq === browseSeq.current) {
        setListing(null)
        setBrowseFailed(true)
        setError((previous) => previous ?? t('error.loadDir'))
      }
    } finally {
      if (seq === browseSeq.current) setBrowsing(false)
    }
  }

  /**
   * The whole "open the dialog" pass: preset health, distro list, and the default browse root.
   *
   * Extracted from the open effect so **Retry can re-run it** (issue #44 §6, `T8`). It used to be an
   * inline `useEffect([open])` body, which left Retry with nothing to call but `setError(null)` — the
   * button cleared the message and the stale answer stayed, so the dialog reported the same failure
   * it had just been asked to re-check. A Retry that does not retry is worse than no button, because
   * it looks like the answer was refreshed.
   *
   * @param cancelled - reads `true` once the effect that owns this pass has been torn down, so a
   *   late answer cannot set state on an unmounted dialog.
   */
  const runOpenPass = (cancelled: () => boolean): void => {
    // Advisory data for the help panel: never fatal, never blocking the form.
    void describe().then(value => { if (!cancelled()) setSelfDescription(value) }).catch(() => { if (!cancelled()) setSelfDescription(null) })
    setOpening(true)
    void (async () => {
      let presetIssue: string | undefined
      try {
        presetIssue = await checkPreset()
      } catch {
        presetIssue = t('error.loadDistros')
      }
      let names: string[]
      try {
        names = await listDistros()
      } catch {
        if (cancelled()) return
        setOpening(false)
        setError(t('error.loadDistros'))
        return
      }
      if (cancelled()) return
      setDistros(names)
      const first = names[0] ?? ''
      setDistro(first)
      // The default browse root walks from `/`; the input defaults to `/home/`.
      setBrowsing(true)
      setOpening(false)
      setError(presetIssue)
      if (first !== '') void refreshBrowse('/', first)
    })()
  }

  /**
   * Retry: re-run the open pass, keeping the dialog open. A separate sequence number guards it the
   * way `browseSeq` guards browsing — a Retry clicked three times must not leave three passes racing
   * to write the same state, and the last one to answer is not necessarily the last one asked.
   */
  const [retrySeq, setRetrySeq] = useState<number>(0)
  useEffect(() => {
    if (!open || retrySeq === 0) return
    let cancelled = false
    runOpenPass(() => cancelled)
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one pass per retry, against current t.
  }, [open, retrySeq])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setError(null)
    setPathStatus('idle')
    setPathNote(null)
    runOpenPass(() => cancelled)
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per open against current t.
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy])

  if (!open) {
    // A W-letter action beside Settings at the sidebar foot; the title
    // carries the label in both wide and rail states.
    return (
      <button
        type="button"
        className={wide ? 'dww-action dww-action--wide' : 'dww-action dww-action--rail'}
        title={t('action.title')}
        aria-label={t('action.title')}
        onClick={() => setOpen(true)}
      >
        <span className="dww-letter" aria-hidden="true">W</span>
      </button>
    )
  }

  /**
   * Move the browse box and the path input to one directory: breadcrumb
   * segment, quick path, or tree drill. The inline check is dropped because the
   * answer belonged to the previous path, not this one.
   * @param next - the absolute Linux directory to browse.
   */
  const goToPath = (next: string): void => {
    setPathInput(next)
    setPathStatus('idle')
    setPathNote(null)
    void refreshBrowse(next, distro)
  }

  const onDrill = (name: string): void => {
    goToPath(dirChildPath(listing?.path ?? browsePath, name))
  }

  const onUp = (): void => {
    const parent = listing?.parent ?? null
    if (parent === null) return
    goToPath(parent)
  }

  const onDistroChange = (value: string): void => {
    setDistro(value)
    setPathStatus('idle')
    setPathNote(null)
    void refreshBrowse(browsePath, value)
  }

  /**
   * Check the typed path. The answer is shown inline under the input rather
   * than only in the dialog's error strip: "which of these two fields is
   * wrong" is the question a reader has at that moment, and replacing the
   * whole form with an error banner made the path field look unchanged.
   */
  const onCheck = async (): Promise<void> => {
    const path = normalizeLinuxPath(pathInput)
    setError(null)
    if (!isAbsoluteLinuxPath(path) || path === '/') {
      setPathStatus('invalid')
      setPathNote(t('error.invalidPath'))
      return
    }
    setPathStatus('checking')
    setPathNote(null)
    let facts: WslPathCheck
    try {
      facts = await check(distro, path)
    } catch {
      setPathStatus('invalid')
      setPathNote(t('error.pathNotFound'))
      return
    }
    if (!facts.exists || !facts.isDirectory) {
      setPathStatus('invalid')
      setPathNote(t('error.pathNotFound'))
      return
    }
    setPathStatus('ok')
    setPathNote(t('dialog.pathOk'))
    void refreshBrowse(path, distro)
  }

  const onConfirm = async (): Promise<void> => {
    const path = normalizeLinuxPath(pathInput)
    setError(null)
    if (!isAbsoluteLinuxPath(path) || path === '/') {
      // A workspace at the distribution root would make every session start
      // at `/`; the check flow rejects it and confirm must agree.
      setError(t('error.invalidPath'))
      return
    }
    const user = username.trim()
    if (user !== '' && !isValidWslUsername(user)) {
      setError(t('error.invalidUsername'))
      return
    }
    setBusy(true)
    try {
      let facts: WslPathCheck
      try {
        facts = await check(distro, path)
      } catch {
        setError(t('error.pathNotFound'))
        return
      }
      if (!facts.exists || !facts.isDirectory) {
        setError(t('error.pathNotFound'))
        return
      }
      const failure = await createWorkspace(path, user, distro)
      if (failure !== undefined) {
        setError(failure)
        return
      }
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  const children = (listing?.entries.filter(entry => entry.kind === 'directory') ?? []).map(entry => entry.name)
  const maskClick = (): void => { if (!busy) setOpen(false) }
  const listScroll: UIEventHandler<HTMLDivElement> = () => { /* scroll container handles overflow */ }

  return (
    <div className="dww-overlay">
      <div className="dww-overlay-mask" onClick={maskClick} />
      <div className="dww-card" role="dialog" aria-modal="true" aria-label={t('dialog.title')}>
        <div className="dww-header">
          <h2 className="dww-title">{t('dialog.title')}</h2>
          <button
            type="button"
            className="dww-help-btn"
            title={t('help.button')}
            aria-label={t('help.button')}
            aria-pressed={helpOpen}
            onClick={() => setHelpOpen(value => !value)}
          >
            ?
          </button>
          <button type="button" className="dww-close" aria-label={t('dialog.cancel')} onClick={maskClick}>
            ✕
          </button>
        </div>
        <div className="dww-body">
          {helpOpen ? (
            <WslHelp t={t} description={selfDescription} />
          ) : (<>
          {error !== null ? (
            <div className="dww-error">
              {error}
              <button type="button" className="dww-retry" onClick={() => setRetrySeq((sequence: number) => sequence + 1)}>{t('dialog.retry')}</button>
            </div>
          ) : null}
          <div className="dww-field">
            <label className="dww-field-label" htmlFor="dww-distro">{t('dialog.distro')}</label>
            <select
              id="dww-distro"
              className="dww-select"
              value={distro}
              disabled={opening || busy}
              onChange={event => onDistroChange(event.target.value)}
            >
              {distros.length === 0
                ? <option value="">{opening ? t('dialog.loading') : ''}</option>
                : distros.map(name => <option key={name} value={name}>{name}</option>)}
            </select>
          </div>
          <div className="dww-field">
            <label className="dww-field-label" htmlFor="dww-path">{t('dialog.path')}</label>
            <div className="dww-input-row">
              <input
                id="dww-path"
                className="dww-input"
                value={pathInput}
                placeholder={t('dialog.pathPlaceholder')}
                disabled={opening || busy}
                onChange={event => {
                  setPathInput(event.target.value)
                  setPathStatus('idle')
                  setPathNote(null)
                }}
                onKeyDown={event => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  if (!opening && !busy && pathStatus !== 'checking') void onCheck()
                }}
              />
              <button
                type="button"
                className="dww-check-btn"
                disabled={opening || busy || pathStatus === 'checking'}
                onClick={() => void onCheck()}
              >
                {pathStatus === 'checking' ? t('dialog.checking') : t('dialog.check')}
              </button>
            </div>
            {pathStatus !== 'idle' ? (
              <div
                className={pathStatus === 'ok'
                  ? 'dww-path-status dww-path-status--ok'
                  : pathStatus === 'invalid'
                    ? 'dww-path-status dww-path-status--invalid'
                    : 'dww-path-status'}
                role="status"
                aria-live="polite"
              >
                {pathStatus === 'checking' ? t('dialog.checking') : pathNote}
              </div>
            ) : null}
          </div>
          <div className="dww-field">
            <label className="dww-field-label" htmlFor="dww-username">{t('dialog.username')}</label>
            <input
              id="dww-username"
              className="dww-input"
              value={username}
              placeholder={t('dialog.usernamePlaceholder')}
              disabled={opening || busy}
              autoComplete="off"
              spellCheck={false}
              onChange={event => setUsername(event.target.value)}
              onKeyDown={event => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                if (!opening && !busy) void onConfirm()
              }}
            />
          </div>
          <div className="dww-feedback">
            <div className="dww-breadcrumb">
              {pathSegments(browsePath).map((segment, index) => (
                <Fragment key={segment.path}>
                  {index > 0 ? <span className="dww-breadcrumb-sep">/</span> : null}
                  <button
                    type="button"
                    className="dww-breadcrumb-link"
                    title={segment.path}
                    onClick={() => goToPath(segment.path)}
                  >
                    {index === 0 ? t('dialog.breadcrumbRoot') : segment.label}
                  </button>
                </Fragment>
              ))}
            </div>
            <div className="dww-quick">
              <span className="dww-quick-label">{t('dialog.quick')}</span>
              {QUICK_PATHS.map(item => (
                <button
                  key={item.path}
                  type="button"
                  className="dww-quick-chip"
                  disabled={opening || busy || distro === ''}
                  onClick={() => goToPath(item.path)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="dww-dirlist" onScroll={listScroll}>
              {browsing ? (
                <div className="dww-dir-empty">{t('dialog.loading')}</div>
              ) : (<>
                {listing !== null && listing.parent !== null ? (
                  <button type="button" className="dww-dir-row dww-dir-row--up" onClick={onUp}>
                    <WslGlyph size={14} />
                    <span>{t('dialog.upLevel')}</span>
                  </button>
                ) : null}
                {browseFailed ? <div className="dww-dir-empty">{t('error.loadDir')}</div> : null}
                {!browseFailed && children.length === 0
                  ? <div className="dww-dir-empty">{t('dialog.browseEmpty')}</div>
                  : null}
                {browseFailed ? null : children.map(name => (
                  <button type="button" key={name} className="dww-dir-row" onClick={() => onDrill(name)}>
                    <WslGlyph size={14} />
                    <span>{name}</span>
                    <span className="dww-dir-go" aria-hidden="true">›</span>
                  </button>
                ))}
              </>)}
            </div>
          </div>
          </>)}
        </div>
        <div className="dww-actions">
          <button type="button" className="dww-btn" disabled={busy} onClick={maskClick}>{t('dialog.cancel')}</button>
          <button type="button" className="dww-btn dww-btn--primary" disabled={busy || opening} onClick={() => void onConfirm()}>
            {busy ? t('dialog.loading') : t('dialog.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}

export type { ApiCall }
