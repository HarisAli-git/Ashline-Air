import React, { useState } from 'react';
import { ContractBoard } from './ContractBoard';
import { EconomyScreen } from './EconomyScreen';
import { useNotification } from '../../store/gameStore';

type Tab = 'contracts' | 'economy';

interface Props {
  settlementId: string;
}

export function PreFlightOverlay({ settlementId }: Props): React.ReactElement {
  const [tab, setTab] = useState<Tab>('contracts');
  const [contractAccepted, setContractAccepted] = useState(false);
  const notification = useNotification();

  return (
    <div style={styles.overlay}>
      {/* Notification */}
      {notification && (
        <div style={{ ...styles.toast, borderColor: toastColor(notification.type) }}>
          {notification.message}
        </div>
      )}

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
      <div style={styles.content}>
        {tab === 'contracts' && (
          <ContractBoard
            settlementId={settlementId}
            onContractAccepted={() => setContractAccepted(true)}
          />
        )}
        {tab === 'economy' && <EconomyScreen settlementId={settlementId} />}
      </div>
    </div>
  );
}

function toastColor(type: string): string {
  return { info: '#88ccff', warning: '#ffd080', danger: '#ff4444', success: '#00ff88' }[type] ?? '#888';
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    top: 80,
    left: '50%',
    transform: 'translateX(-50%)',
    width: 560,
    maxHeight: '75vh',
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
    overflowY: 'auto',
    flex: 1,
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
