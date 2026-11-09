import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { MoreIcon } from './icons.tsx'

export type RowMenuItem = {
  key: string
  label: string
  /** Accessible name when it differs from the visible label. */
  ariaLabel?: string
  onSelect: () => void
  disabled?: boolean
  /** Renders a menuitemcheckbox. */
  checked?: boolean
  destructive?: boolean
}

type RowMenuProps = { label: string; items: RowMenuItem[]; disabled?: boolean }

/** The "⋯" overflow menu of a recording row. */
export function RowMenu({ label, items, disabled = false }: RowMenuProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    const first = rootRef.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')
    first?.focus()
    const onPointerDown = (event: PointerEvent | MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node | null)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open])

  function close(restoreFocus: boolean) {
    setOpen(false)
    if (restoreFocus) buttonRef.current?.focus()
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const entries = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')]
    const index = entries.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true) }
    else if (event.key === 'ArrowDown') { event.preventDefault(); entries[(index + 1) % entries.length]?.focus() }
    else if (event.key === 'ArrowUp') { event.preventDefault(); entries[(index - 1 + entries.length) % entries.length]?.focus() }
    else if (event.key === 'Home') { event.preventDefault(); entries[0]?.focus() }
    else if (event.key === 'End') { event.preventDefault(); entries[entries.length - 1]?.focus() }
    else if (event.key === 'Tab') setOpen(false)
  }

  return (
    <div className="transcription-menu" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="transcription-icon-button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => { if (event.key === 'ArrowDown' && !open) { event.preventDefault(); setOpen(true) } }}
      ><MoreIcon /></button>
      {open && (
        <div className="transcription-menu-list" id={menuId} role="menu" aria-label={label} onKeyDown={onMenuKeyDown}>
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
              aria-checked={item.checked}
              aria-label={item.ariaLabel}
              className={item.destructive ? 'is-destructive' : undefined}
              disabled={item.disabled}
              onClick={() => { close(false); item.onSelect() }}
            >
              {item.checked !== undefined && <span className="transcription-menu-check" aria-hidden="true">{item.checked ? '✓' : ''}</span>}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
