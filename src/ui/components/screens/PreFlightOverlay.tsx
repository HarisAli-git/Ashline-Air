import React, { useState } from 'react';
import { DispatchBoard } from './DispatchBoard';
import { EconomyScreen } from './EconomyScreen';

type Tab = 'contracts' | 'economy';

interface Props {
  settlementId: string;
}

export function PreFlightOverlay({ settlementId }: Props): React.ReactElement {
  const [tab, setTab] = useState<Tab>('contracts');
  const [, setContractAccepted] = useState(false);

  return (
    <div style={styles.overlay}>
      {/* Notifications are rendered by the always-mounted GlobalNotification */}

      {/* Tab bar */}
      <div style={styles.tabs}>
        <button
          style={{ ...styles.tab, ...(tab === 'contracts' ? styles.activeTab : {}) }}
          onClick={() => setTab('contracts')}
        >
          CONTRACTS
        </button>
        <button
          style={{ ...styles.tab, ...(tab === 'economy' ? styles.activeTab : {}) }}
          onClick={() => setTab('economy')}
        >
          SERVICES
        </button>
      </div>

      {/* Content */}
      {/*
        * NOT scrollable. The board manages its own scrolling internally so
        * that its dispatch bar can stay pinned; a scroll container here would
        * carry the bar off the bottom with the list, which is the whole bug
        * this screen had.
        */}
      <div style={styles.content}>
        {tab === 'contracts' && (
          <DispatchBoard
            settlementId={settlementId}
            onContractAccepted={() => setContractAccepted(true)}
          />
        )}
        {tab === 'economy' && <EconomyScreen settlementId={settlementId} />}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    // absolute so it belongs to the canvas rect, and sized against the screen:
    // a fixed 560 px box at top:80 overhung a phone and pushed its own FLY
    // button below the fold.
    position: 'absolute',
    top: 'calc(56px + env(safe-area-inset-top, 0px))',
    left: '50%',
    transform: 'translateX(-50%)',
    width: 'min(560px, calc(100% - 24px))',
    height: 'calc(100% - 88px)',
    maxHeight: 'calc(100% - 88px)',
    pointerEvents: 'auto',
    background: 'rgba(10,8,4,0.96)',
    border: '1px solid #3a2a10',
    borderRadius: 4,
    display: 'flex',
    flexDirection: 'column',
    fontFamily: 'monospace',
    zIndex: 100,
    overflow: 'hidden',
  },
  tabs: {
    display: 'flex',
    borderBottom: '1px solid #3a2a10',
  },
  tab: {
    flex: 1,
    minHeight: 44,   // tappable
    background: 'transparent',
    border: 'none',
    borderBottom: '2px solid transparent',
    color: '#6a5a3a',
    fontFamily: 'monospace',
    fontSize: 13,
    padding: '10px 0',
    cursor: 'pointer',
    letterSpacing: 2,
  },
  activeTab: {
    color: '#ffd080',
    borderBottomColor: '#ffd080',
  },
  content: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  toast: {
    background: 'rgba(10,8,4,0.95)',
    border: '1px solid',
    padding: '8px 16px',
    fontSize: 13,
    color: '#e8d5b7',
    margin: 12,
    borderRadius: 3,
  },
};
