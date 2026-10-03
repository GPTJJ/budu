import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import PurchaseReceiptPage from '../src/components/PurchaseReceiptPage.jsx';
import ProductCenterPage from '../src/components/ProductCenterPage.jsx';
import AccountAdminPage from '../src/components/AccountAdminPage.jsx';
import '../src/index.css';
function Harness() {
  const [user, setUser] = useState(null),
    [error, setError] = useState('');
  const q = new URLSearchParams(location.search),
    role = q.get('actor') || 'dev',
    view = q.get('view') || 'purchase';
  useEffect(() => {
    (async () => {
      await fetch('/__fixture/actor/' + role);
      const r = await fetch('/api/auth/me');
      const d = await r.json();
      if (!r.ok) throw Error(d.error);
      setUser(d.user);
    })().catch(e => setError(e.message));
  }, []);
  return error ? <p role="alert">{error}</p> : !user ? <p>加载合成账号</p> : view === 'products' ? <ProductCenterPage user={user} onBack={() => {}} /> : view === 'accounts' ? <AccountAdminPage currentUser={user} onBack={() => {}} /> : <PurchaseReceiptPage currentUser={user} />;
}
createRoot(document.getElementById('root')).render(<Harness />);
