import type { ReactNode } from 'react'

function Icon({ children, size = 14 }: { children: ReactNode; size?: number }) {
  return (
    <svg className="transcription-icon" width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
      {children}
    </svg>
  )
}

export const PlayIcon = ({ size }: { size?: number }) => <Icon size={size}><path d="M5 3.2v9.6a.5.5 0 0 0 .77.42l7.4-4.8a.5.5 0 0 0 0-.84l-7.4-4.8A.5.5 0 0 0 5 3.2Z" /></Icon>
export const PauseIcon = ({ size }: { size?: number }) => <Icon size={size}><rect x="4" y="3" width="3" height="10" rx="0.8" /><rect x="9" y="3" width="3" height="10" rx="0.8" /></Icon>
export const PrevIcon = () => <Icon><rect x="3" y="3" width="1.8" height="10" rx="0.6" /><path d="M13 3.4v9.2a.4.4 0 0 1-.63.33L6.1 8.33a.4.4 0 0 1 0-.66l6.27-4.6a.4.4 0 0 1 .63.33Z" /></Icon>
export const NextIcon = () => <Icon><rect x="11.2" y="3" width="1.8" height="10" rx="0.6" /><path d="M3 3.4v9.2a.4.4 0 0 0 .63.33l6.27-4.6a.4.4 0 0 0 0-.66L3.63 3.07A.4.4 0 0 0 3 3.4Z" /></Icon>
export const PlusIcon = () => <Icon><path d="M7.25 3h1.5v4.25H13v1.5H8.75V13h-1.5V8.75H3v-1.5h4.25V3Z" /></Icon>
export const MoreIcon = () => <Icon><circle cx="3.5" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="12.5" cy="8" r="1.3" /></Icon>
export const WaveIcon = () => <Icon><rect x="2" y="6" width="1.6" height="4" rx="0.8" /><rect x="5" y="3.5" width="1.6" height="9" rx="0.8" /><rect x="8" y="5" width="1.6" height="6" rx="0.8" /><rect x="11" y="2.5" width="1.6" height="11" rx="0.8" /></Icon>
export const RecordDotIcon = () => <svg className="transcription-icon transcription-record-dot" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="4.5" fill="currentColor" /></svg>
