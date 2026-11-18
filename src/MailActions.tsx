import { tFormat, t } from './i18n'
import { translateText } from './languageSession'

import type { ReactNode } from 'react'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@ui-sdk/react/menu'
import { Toolbar, ToolbarButton } from '@ui-sdk/react/toolbar'
import { SvgCheck, SvgMoveToFolder } from './icons'
import type { SuggestedFolder } from './types'

type Props = {
  /** Wohin „Erledigt" ablegt; ohne Vorschlag fragt es nach dem Ordner. */
  fileTarget: SuggestedFolder | null
  /** Liegt schon in einem Ordner — dann gibt es nichts mehr zu erledigen. */
  filed: boolean
  onReply: () => void
  onForward: () => void
  onFile: () => void
  onMove: () => void
  onMarkUnread: () => void
  onDelete: () => void
}

type MenuAction = 'move' | 'unread' | 'delete'

/*
 * Eine Hauptaktion, zwei Nebenaktionen mit Beschriftung, der Rest im Menü.
 * Löschen steht bewusst nicht als loses „×" an der Karte: es sah aus wie
 * „Schließen" und löschte die ganze Unterhaltung.
 */
export function MailActions({
  fileTarget,
  filed,
  onReply,
  onForward,
  onFile,
  onMove,
  onMarkUnread,
  onDelete,
}: Props) {
  const menuActions: Record<MenuAction, () => void> = {
    move: onMove,
    unread: onMarkUnread,
    delete: onDelete,
  }

  return (
    <Toolbar className="mail-actions" aria-label={t('E-Mail-Aktionen')}>
      <ToolbarButton className="mail-action mail-action--primary" onClick={onReply}>
        <SvgReply />
        <span>{t('Antworten')}</span>
      </ToolbarButton>
      <ToolbarButton className="mail-action" onClick={onForward}>
        <SvgForward />
        <span>{t('Weiterleiten')}</span>
      </ToolbarButton>
      {filed ? null : (
        <ToolbarButton
          className="mail-action mail-action--file"
          onClick={onFile}
          data-testid="mail-file"
          title={
            fileTarget === null
              ? t('Erledigt — Ordner wählen')
              : tFormat('Erledigt und in „{0}" ablegen', fileTarget.name)
          }
        >
          <SvgCheck className="email-action-svg" />
          <span>{t('Erledigt')}</span>
          {fileTarget === null ? null : (
            <span className="mail-action-target">→ {translateText(fileTarget.name)}</span>
          )}
        </ToolbarButton>
      )}
      <Menu onAction={(value) => menuActions[value as MenuAction]?.()}>
        <ToolbarButton
          render={<MenuTrigger />}
          className="mail-action mail-action--icon"
          aria-label={t('Weitere Aktionen')}
          title={t('Weitere Aktionen')}
        >
          <SvgMore />
        </ToolbarButton>
        <MenuContent className="mail-menu" align="end" sideOffset={6}>
          <MenuItem value="move" className="mail-menu-item">
            <SvgMoveToFolder />
            {t('In Ordner verschieben …')}
          </MenuItem>
          <MenuItem value="unread" className="mail-menu-item">
            <SvgMarkUnread />
            {t('Als ungelesen markieren')}
          </MenuItem>
          <MenuSeparator className="mail-menu-separator" />
          <MenuItem value="delete" destructive className="mail-menu-item">
            <SvgTrash />
            {t('Unterhaltung löschen …')}
          </MenuItem>
        </MenuContent>
      </Menu>
    </Toolbar>
  )
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="email-action-svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  )
}

function SvgReply() {
  return (
    <Icon>
      <polyline points="9 17 4 12 9 7" />
      <path d="M20 17v-2a4 4 0 0 0-4-4H4" />
    </Icon>
  )
}

function SvgForward() {
  return (
    <Icon>
      <polyline points="15 17 20 12 15 7" />
      <path d="M4 18v-2a4 4 0 0 1 4-4h12" />
    </Icon>
  )
}

function SvgMarkUnread() {
  return (
    <Icon>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
      <circle cx="19" cy="5" r="2.5" fill="currentColor" stroke="none" />
    </Icon>
  )
}

function SvgTrash() {
  return (
    <Icon>
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6l-1 14H6L5 6" />
    </Icon>
  )
}

function SvgMore() {
  return (
    <Icon>
      <circle cx="5" cy="12" r="1" fill="currentColor" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
      <circle cx="19" cy="12" r="1" fill="currentColor" />
    </Icon>
  )
}
