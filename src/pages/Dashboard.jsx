import React, { useEffect, useState, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { useNavigate } from 'react-router-dom';

const fmt = {
    currency: (n) => '₹' + Number(n || 0).toLocaleString('en-IN'),
    count: (n) => Number(n || 0).toLocaleString('en-IN'),
    datetime: (d) => {
        const dt = new Date(d);
        return dt.toLocaleString('en-IN', {
            day: 'numeric', month: 'numeric', year: 'numeric',
            hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
        });
    },
    initials: (email) => (email || '?').charAt(0).toUpperCase(),
};

function ToastContainer({ toasts }) {
    return (
        <div className="toast-container" id="toastContainer">
            {toasts.map(t => (
                <div key={t.id} className={`toast ${t.type}`}>
                    <span>{t.msg}</span>
                </div>
            ))}
        </div>
    );
}

export default function Dashboard({ session }) {
    const [profile, setProfile] = useState(null);
    const [role, setRole] = useState(null);
    const [denominations, setDenominations] = useState([]);
    const [transactions, setTransactions] = useState([]);
    const [formState, setFormState] = useState({});
    const [toasts, setToasts] = useState([]);
    const [clock, setClock] = useState('');
    const [loading, setLoading] = useState(true);

    const [editModalTx, setEditModalTx] = useState(null); // When editing a transaction
    const [editNotesIn, setEditNotesIn] = useState('');
    const [editNotesOut, setEditNotesOut] = useState('');

    const navigate = useNavigate();
    const formStateRef = useRef(formState);

    // Keep ref in sync for event callbacks
    useEffect(() => {
        formStateRef.current = formState;
    }, [formState]);

    const showToast = (msg, type = 'info') => {
        const id = Date.now() + Math.random();
        setToasts(prev => [...prev, { id, msg, type }]);
        setTimeout(() => {
            setToasts(prev => prev.filter(t => t.id !== id));
        }, 3500);
    };

    useEffect(() => {
        const timer = setInterval(() => {
            setClock(new Date().toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' }));
        }, 1000);
        return () => clearInterval(timer);
    }, []);

    useEffect(() => {
        async function boot() {
            // Fetch profile & role
            const { data: prof, error: profileErr } = await supabase
                .from('profiles')
                .select('*')
                .eq('id', session.user.id)
                .single();

            if (profileErr || !prof) {
                showToast('Could not load your profile. Please contact admin.', 'error');
                return;
            }

            setProfile(prof);
            setRole(prof.role);

            await Promise.all([loadDenominations(), loadTransactions()]);
            setLoading(false);
            subscribeRealtime();
        }

        boot();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [session.user.id]);

    async function loadDenominations() {
        const { data, error } = await supabase
            .from('denominations')
            .select('*')
            .order('sort_order', { ascending: true });

        if (error) { console.error('Denominations error:', error); return; }

        setDenominations(data || []);

        setFormState(prev => {
            const next = { ...prev };
            (data || []).forEach(d => {
                if (!next[d.id]) next[d.id] = { notes_in: 0, notes_out: 0 };
            });
            return next;
        });
    }

    async function loadTransactions() {
        const { data, error } = await supabase
            .from('transactions')
            .select('*, denominations(value, label), profiles(email, full_name)')
            .order('created_at', { ascending: false });

        if (error) { console.error('Transactions error:', error); return; }
        setTransactions(data || []);
    }

    function subscribeRealtime() {
        supabase.channel('public-changes')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'denominations' }, async () => {
                await loadDenominations();
            })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'transactions' }, async () => {
                await loadTransactions();
                await loadDenominations();
            })
            .subscribe((status) => {
                if (status === 'SUBSCRIBED') {
                    console.log('[Realtime] Connected');
                }
            });
    }

    async function logAudit(action, details = {}) {
        await supabase.from('audit_log').insert({
            user_id: session.user.id,
            action,
            details: { ...details, user_email: session.user.email },
        });
    }

    const handleDenomChange = (id, field, val) => {
        const intVal = val === '' ? 0 : parseInt(val) || 0;
        setFormState(prev => ({
            ...prev,
            [id]: {
                ...prev[id],
                [field]: Math.max(0, intVal)
            }
        }));
    };

    const handleClearFields = () => {
        setFormState(prev => {
            const next = { ...prev };
            Object.keys(next).forEach(k => {
                next[k] = { notes_in: 0, notes_out: 0 };
            });
            return next;
        });
    };

    const [saving, setSaving] = useState(false);

    const handleSaveEntry = async () => {
        if (role === 'Auditor') {
            showToast('Auditors cannot create transactions.', 'error');
            return;
        }

        const entriesToSave = [];
        const currentState = formStateRef.current;

        for (const [denomId, state] of Object.entries(currentState)) {
            if (state.notes_in > 0 || state.notes_out > 0) {
                const denom = denominations.find(d => d.id === denomId);
                const userAvailable = userStockMap[denom.id] || 0;
                if (state.notes_out > userAvailable + state.notes_in) {
                    showToast(`Insufficient stock for ₹${denom.value}.`, 'error');
                    return;
                }

                entriesToSave.push({
                    user_id: session.user.id,
                    denomination_id: denomId,
                    notes_in: state.notes_in,
                    notes_out: state.notes_out,
                    note: 'Bulk entry'
                });
            }
        }

        if (entriesToSave.length === 0) {
            showToast('Please enter notes in or out before saving.', 'error');
            return;
        }

        setSaving(true);
        const { error } = await supabase.from('transactions').insert(entriesToSave);
        setSaving(false);

        if (error) {
            showToast('Error: ' + (error.message || 'Could not save transactions.'), 'error');
            return;
        }

        await logAudit(`Added bulk transaction entry`, { count: entriesToSave.length });
        showToast('Entry saved successfully!', 'success');
        handleClearFields();

        await Promise.all([loadTransactions(), loadDenominations()]);
    };

    const handleEditSaved = async (e) => {
        e.preventDefault();
        const id = editModalTx.id;
        const nIn = parseInt(editNotesIn) || 0;
        const nOut = parseInt(editNotesOut) || 0;

        const { error } = await supabase.from('transactions')
            .update({ notes_in: nIn, notes_out: nOut })
            .eq('id', id);

        if (error) {
            showToast('Update failed: ' + error.message, 'error');
        } else {
            showToast('Transaction updated', 'success');
            setEditModalTx(null);
            await Promise.all([loadTransactions(), loadDenominations()]);
        }
    };

    const handleDelete = async (id) => {
        if (!window.confirm('Are you sure you want to delete this transaction?')) return;
        showToast('Deleting transaction...', 'info');
        const { error } = await supabase.from('transactions').delete().eq('id', id);
        if (error) {
            showToast('Delete failed: ' + error.message, 'error');
        } else {
            showToast('Transaction deleted', 'success');
            await Promise.all([loadTransactions(), loadDenominations()]);
        }
    };

    const handleLogout = async () => {
        await supabase.auth.signOut();
        navigate('/');
    };

    // Computations
    let totalInVal = 0;
    let totalOutVal = 0;
    transactions.forEach(tx => {
        const val = tx.denominations?.value || 0;
        totalInVal += tx.notes_in * val;
        totalOutVal += tx.notes_out * val;
    });
    const netBalance = totalInVal - totalOutVal;

    let uiTotalNotesIn = 0;
    let uiTotalInValue = 0;
    let uiTotalNotesOut = 0;
    let uiTotalOutValue = 0;
    let uiTotalFinalStock = 0;
    let uiTotalBalanceValue = 0;

    // History Grouping (By Session/Batch) with Running Balance calculation
    // Note: transactions are ordered by created_at DESC (newest first)
    const batches = [];

    // To calculate running balances accurately for display, we'll first process 
    // transactions in chronological order (ascending) starting from 0 (if we had the start)
    // or simply display the batch's net effect if start balance isn't known.
    // However, the screenshot shows a likely cumulative balance.
    // We'll calculate a 'pseudo' running balance for the session.

    transactions.forEach(tx => {
        const tTime = new Date(tx.created_at).getTime();
        let batch = batches.find(g => Math.abs(g.time - tTime) < 5000 && g.user_id === tx.user_id && g.note === tx.note);
        if (!batch) {
            batch = {
                time: tTime,
                created_at: tx.created_at,
                items: [],
                user_id: tx.user_id,
                note: tx.note,
                totalIn: 0,
                totalOut: 0,
                id: `batch-${tTime}`,
                runningTotal: 0
            };
            batches.push(batch);
        }
        batch.items.push(tx);
        const val = tx.denominations?.value || 0;
        batch.totalIn += tx.notes_in * val;
        batch.totalOut += tx.notes_out * val;
    });

    // Calculate Grand Totals (Running Balance)
    // We'll approximate this by summing the net balances from oldest to newest
    let currentRunning = 0;
    [...batches].reverse().forEach(b => {
        currentRunning += (b.totalIn - b.totalOut);
        b.runningTotal = currentRunning;
    });

    // Date-wise Grouping of Batches
    const dateGroups = [];
    batches.forEach(batch => {
        const dateStr = new Date(batch.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
        let dateGroup = dateGroups.find(dg => dg.date === dateStr);
        if (!dateGroup) {
            dateGroup = { date: dateStr, batches: [], dayTotalIn: 0, dayTotalOut: 0 };
            dateGroups.push(dateGroup);
        }
        dateGroup.batches.push(batch);
        dateGroup.dayTotalIn += batch.totalIn;
        dateGroup.dayTotalOut += batch.totalOut;
    });

    // Pre-calculate user stock from transactions (Multi-user isolation)
    const userStockMap = {};
    denominations.forEach(d => userStockMap[d.id] = 0);
    transactions.forEach(tx => {
        if (!userStockMap[tx.denomination_id]) userStockMap[tx.denomination_id] = 0;
        userStockMap[tx.denomination_id] += (tx.notes_in - tx.notes_out);
    });

    // History toggle state
    const [expandedBatches, setExpandedBatches] = useState({});
    useEffect(() => {
        if (batches.length > 0 && Object.keys(expandedBatches).length === 0) {
            setExpandedBatches({ [batches[0].id]: true });
        }
    }, [batches, expandedBatches]);

    const toggleBatch = (id) => {
        setExpandedBatches(prev => ({ ...prev, [id]: !prev[id] }));
    };

    // Pre-calculate session UI totals for summary cards
    denominations.forEach(d => {
        const rowState = formState[d.id] || { notes_in: 0, notes_out: 0 };
        const userAvailable = userStockMap[d.id] || 0;
        const finalStock = userAvailable + rowState.notes_in - rowState.notes_out;
        uiTotalNotesIn += rowState.notes_in;
        uiTotalInValue += rowState.notes_in * d.value;
        uiTotalNotesOut += rowState.notes_out;
        uiTotalOutValue += rowState.notes_out * d.value;
        uiTotalFinalStock += finalStock;
        uiTotalBalanceValue += (finalStock * d.value);
    });

    if (loading) {
        return <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center' }}>Loading dashboard...</div>;
    }

    return (
        <>
            <header className="topbar">
                <div className="topbar-left">
                    <span className="topbar-logo-icon">🗄️</span>
                    <div className="topbar-title-wrap">
                        <h1>Cash Inventory Manager</h1>
                        <p>Track your cash denominations with precision</p>
                    </div>
                </div>
                <div className="topbar-right">
                    <div className="clock-wrap">
                        <div className="clock-time">{clock}</div>
                        <div className="clock-date">{new Date().toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div>
                    </div>
                    <div className="user-avatar" title={`${session.user.email} (${role})`} onClick={handleLogout} style={{ cursor: 'pointer', border: '1px solid white' }}>
                        {fmt.initials(session.user.email)}
                    </div>
                </div>
            </header>

            <main className="main-container">
                {/* Summary Cards */}
                <div className="summary-cards">
                    <div className="card green">
                        <div className="card-info">
                            <span className="card-label">Total In</span>
                            <span className="card-value">{fmt.currency(uiTotalInValue)}</span>
                        </div>
                        <span className="card-icon">↗️</span>
                    </div>
                    <div className="card red">
                        <div className="card-info">
                            <span className="card-label">Total Out</span>
                            <span className="card-value">{fmt.currency(uiTotalOutValue)}</span>
                        </div>
                        <span className="card-icon">↘️</span>
                    </div>
                    <div className="card blue">
                        <div className="card-info">
                            <span className="card-label">Net Movement</span>
                            <span className="card-value">{uiTotalInValue >= uiTotalOutValue ? '+' : ''}{fmt.currency(uiTotalInValue - uiTotalOutValue)}</span>
                        </div>
                        <span className="card-icon">📈</span>
                    </div>
                </div>

                {/* Main Table Interface */}
                <div className="table-card">
                    <table className="data-table">
                        <thead>
                            <tr>
                                <th>Denomination (₹)</th>
                                <th>Available</th>
                                <th style={{ color: 'var(--brand-green)' }}>Notes In (+)</th>
                                <th style={{ color: 'var(--brand-red)' }}>Notes Out (-)</th>
                                <th>Final Stock</th>
                                <th>Total Value (₹)</th>
                            </tr>
                        </thead>
                        <tbody>
                            {denominations.length === 0 && (
                                <tr>
                                    <td colSpan="6" className="text-center">No denominations found.</td>
                                </tr>
                            )}
                            {denominations.map(d => {
                                const rowState = formState[d.id] || { notes_in: 0, notes_out: 0 };
                                const userAvailable = userStockMap[d.id] || 0;
                                const finalStock = userAvailable + rowState.notes_in - rowState.notes_out;
                                const totalValue = finalStock * d.value;

                                return (
                                    <tr key={d.id}>
                                        <td>₹{d.value}</td>
                                        <td>{fmt.count(userAvailable)}</td>
                                        <td className="col-highlight-green notes-in">
                                            <div className="input-cell">
                                                <input
                                                    type="number"
                                                    className="styled-input"
                                                    value={rowState.notes_in || ''}
                                                    onChange={(e) => handleDenomChange(d.id, 'notes_in', e.target.value)}
                                                    onKeyDown={(e) => e.key === 'Enter' && handleSaveEntry()}
                                                    placeholder="0"
                                                />
                                            </div>
                                        </td>
                                        <td className="col-highlight-red notes-out">
                                            <div className="input-cell">
                                                <input
                                                    type="number"
                                                    className="styled-input"
                                                    value={rowState.notes_out || ''}
                                                    onChange={(e) => handleDenomChange(d.id, 'notes_out', e.target.value)}
                                                    onKeyDown={(e) => e.key === 'Enter' && handleSaveEntry()}
                                                    placeholder="0"
                                                />
                                            </div>
                                        </td>
                                        <td>{fmt.count(finalStock)}</td>
                                        <td className="text-right">{fmt.currency(totalValue)}</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                        <tfoot>
                            {/* Detailed Breakdown Rows per Screenshot */}
                            <tr className="footer-row footer-row-green">
                                <td className="footer-label" colSpan="2">Notes In (+)</td>
                                <td className="footer-value" colSpan="4">
                                    {denominations
                                        .filter(d => formState[d.id]?.notes_in > 0)
                                        .map(d => formState[d.id].notes_in)
                                        .join(' + ') || '0'}
                                    {uiTotalNotesIn > 0 && ` = ${uiTotalNotesIn}`}
                                </td>
                            </tr>
                            <tr className="footer-row footer-row-red" style={{ backgroundColor: '#fff5f4' }}>
                                <td className="footer-label" colSpan="2" style={{ color: 'var(--brand-red)' }}>Notes Out (-)</td>
                                <td className="footer-value" colSpan="4" style={{ color: 'var(--brand-red)' }}>
                                    {denominations
                                        .filter(d => formState[d.id]?.notes_out > 0)
                                        .map(d => formState[d.id].notes_out)
                                        .join(' + ') || '0'}
                                    {uiTotalNotesOut > 0 && ` = ${uiTotalNotesOut}`}
                                </td>
                            </tr>
                            <tr className="footer-row footer-row-blue">
                                <td className="footer-label" colSpan="2">Final Stock</td>
                                <td className="footer-value" colSpan="4">
                                    <div style={{ display: 'flex', gap: '15px', flexWrap: 'wrap' }}>
                                        {denominations
                                            .filter(d => (formState[d.id]?.notes_in > 0 || formState[d.id]?.notes_out > 0))
                                            .map(d => {
                                                const userAvailable = userStockMap[d.id] || 0;
                                                const currentFinal = userAvailable + (formState[d.id]?.notes_in || 0) - (formState[d.id]?.notes_out || 0);
                                                return (
                                                    <span key={d.id}>
                                                        ₹{d.value} × {currentFinal} = {fmt.currency(currentFinal * d.value)}
                                                    </span>
                                                );
                                            })}
                                    </div>
                                </td>
                            </tr>
                            <tr className="footer-row grand-total-row">
                                <td className="footer-label" colSpan="2">Grand Total</td>
                                <td colSpan="3"></td>
                                <td className="text-right" style={{ fontSize: '1.2rem', color: 'var(--brand-blue)' }}>{fmt.currency(uiTotalBalanceValue)}</td>
                            </tr>
                        </tfoot>
                    </table>
                </div>

                {/* Action Buttons */}
                <div className="form-actions">
                    <button className="btn-large btn-primary" onClick={handleSaveEntry} disabled={saving}>
                        {saving ? 'SAVING...' : 'Save & Update Stock'}
                    </button>
                    <button className="btn-large btn-secondary" onClick={() => window.print()}>Print Report</button>
                </div>

                <div className="history-section" style={{ marginTop: '40px' }}>
                    <h2 style={{ fontSize: '1.2rem', color: 'var(--brand-navy)', marginBottom: '20px' }}>Transaction History</h2>
                    {dateGroups.map(dg => (
                        <div key={dg.date} className="date-group" style={{ marginBottom: '30px' }}>
                            <div className="date-group-header" style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                padding: '12px 20px',
                                background: '#f8fafd',
                                borderRadius: '8px 8px 0 0',
                                borderBottom: '1px solid #e1e8f0'
                            }}>
                                <h3 style={{ margin: 0, fontSize: '0.9rem', fontWeight: 600, color: 'var(--brand-navy)' }}>{dg.date}</h3>
                                <div style={{ display: 'flex', gap: '20px', fontSize: '0.85rem', fontWeight: 600 }}>
                                    <span style={{ color: 'var(--brand-green)' }}>Total Day In: {fmt.currency(dg.dayTotalIn)}</span>
                                    <span style={{ color: 'var(--brand-red)' }}>Total Day Out: {fmt.currency(dg.dayTotalOut)}</span>
                                </div>
                            </div>

                            <div className="table-card" style={{ borderRadius: '0 0 8px 8px', boxShadow: 'none', border: '1px solid #e1e8f0', borderTop: 'none' }}>
                                <table className="data-table history-table">
                                    <thead style={{ background: '#f8fafd' }}>
                                        <tr>
                                            <th style={{ width: '40px' }}>Sr No</th>
                                            <th style={{ width: '40px' }}></th>
                                            <th className="text-left" style={{ fontSize: '0.75rem', color: '#666' }}>TIMESTAMP</th>
                                            <th className="text-right" style={{ fontSize: '0.75rem', color: '#666' }}>TOTAL IN</th>
                                            <th className="text-right" style={{ fontSize: '0.75rem', color: '#666' }}>TOTAL OUT</th>
                                            <th className="text-right" style={{ fontSize: '0.75rem', color: '#666' }}>GRAND TOTAL</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {dg.batches.map((batch, bIdx) => {
                                            const isExpanded = expandedBatches[batch.id];
                                            // Calculate global Sr No (overall index in 'batches' array)
                                            const srNo = batches.findIndex(b => b.id === batch.id) + 1;
                                            return (
                                                <React.Fragment key={batch.id}>
                                                    <tr style={{ borderBottom: isExpanded ? 'none' : '1px solid #f0f0f0' }}>
                                                        <td className="text-center" style={{ fontSize: '0.85rem', fontWeight: 'bold' }}>{srNo}</td>
                                                        <td className="text-center">
                                                            <button
                                                                className="toggle-btn"
                                                                onClick={() => toggleBatch(batch.id)}
                                                                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.8rem' }}
                                                            >
                                                                {isExpanded ? '▼' : '▶'}
                                                            </button>
                                                        </td>
                                                        <td className="text-left" style={{ fontSize: '0.9rem' }}>
                                                            {new Date(batch.created_at).toLocaleString('en-IN', {
                                                                day: 'numeric', month: 'numeric', year: 'numeric',
                                                                hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true
                                                            })}
                                                        </td>
                                                        <td className="text-right" style={{ color: 'var(--brand-green)', fontWeight: 500 }}>{batch.totalIn > 0 ? fmt.currency(batch.totalIn) : '₹0'}</td>
                                                        <td className="text-right" style={{ color: 'var(--brand-red)', fontWeight: 500 }}>{batch.totalOut > 0 ? fmt.currency(batch.totalOut) : '₹0'}</td>
                                                        <td className="text-right" style={{ fontWeight: 'bold', color: '#000' }}>{fmt.currency(batch.runningTotal)}</td>
                                                    </tr>
                                                    {isExpanded && (
                                                        <tr className="expand-row">
                                                            <td colSpan="6" style={{ padding: '0 20px 20px 60px' }}>
                                                                <div className="inner-table-wrap" style={{
                                                                    background: '#fff',
                                                                    border: '1px solid #e1e8f0',
                                                                    borderRadius: '4px',
                                                                    overflow: 'hidden'
                                                                }}>
                                                                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                                                        <thead style={{ background: '#f8fafd' }}>
                                                                            <tr>
                                                                                <th className="text-center" style={{ padding: '10px', fontSize: '0.7rem', color: '#666' }}>SR NO</th>
                                                                                <th className="text-left" style={{ padding: '10px', fontSize: '0.7rem', color: '#666' }}>DENOMINATION</th>
                                                                                <th className="text-center" style={{ padding: '10px', fontSize: '0.7rem', color: '#666' }}>NOTES IN</th>
                                                                                <th className="text-center" style={{ padding: '10px', fontSize: '0.7rem', color: '#666' }}>IN AMOUNT</th>
                                                                                <th className="text-center" style={{ padding: '10px', fontSize: '0.7rem', color: '#666' }}>NOTES OUT</th>
                                                                                <th className="text-center" style={{ padding: '10px', fontSize: '0.7rem', color: '#666' }}>OUT AMOUNT</th>
                                                                            </tr>
                                                                        </thead>
                                                                        <tbody>
                                                                            {batch.items.map((tx, idx) => (
                                                                                <React.Fragment key={tx.id}>
                                                                                    <tr style={{ borderTop: '1px solid #f0f0f0' }}>
                                                                                        <td className="text-center" style={{ padding: '12px 10px', fontSize: '0.8rem' }}>{idx + 1}</td>
                                                                                        <td className="text-left" style={{ padding: '12px 10px', color: 'var(--brand-blue)', fontWeight: 500 }}>₹{tx.denominations?.value}</td>
                                                                                        <td className="text-center" style={{ color: 'var(--brand-green)' }}>{tx.notes_in || '0'}</td>
                                                                                        <td className="text-center" style={{ color: 'var(--brand-green)' }}>{tx.notes_in > 0 ? fmt.currency(tx.notes_in * tx.denominations.value) : '₹0'}</td>
                                                                                        <td className="text-center" style={{ color: 'var(--brand-red)' }}>{tx.notes_out || '0'}</td>
                                                                                        <td className="text-center" style={{ color: 'var(--brand-red)' }}>{tx.notes_out > 0 ? fmt.currency(tx.notes_out * tx.denominations.value) : '₹0'}</td>
                                                                                    </tr>
                                                                                    <tr>
                                                                                        <td colSpan="6" style={{ padding: '10px', textAlign: 'left' }}>
                                                                                            <div style={{ display: 'flex', gap: '10px' }}>
                                                                                                <button
                                                                                                    className="btn-txn-action edit"
                                                                                                    onClick={() => {
                                                                                                        showToast('Opening edit window...', 'info');
                                                                                                        setEditModalTx(tx);
                                                                                                        setEditNotesIn(tx.notes_in);
                                                                                                        setEditNotesOut(tx.notes_out);
                                                                                                    }}
                                                                                                    style={{
                                                                                                        background: 'var(--brand-blue)',
                                                                                                        color: '#fff',
                                                                                                        border: 'none',
                                                                                                        padding: '5px 15px',
                                                                                                        borderRadius: '4px',
                                                                                                        cursor: 'pointer',
                                                                                                        fontSize: '0.75rem',
                                                                                                        fontWeight: 'bold'
                                                                                                    }}
                                                                                                >
                                                                                                    EDIT
                                                                                                </button>
                                                                                                <button
                                                                                                    className="btn-txn-action delete"
                                                                                                    onClick={() => handleDelete(tx.id)}
                                                                                                    style={{
                                                                                                        background: 'var(--brand-red)',
                                                                                                        color: '#fff',
                                                                                                        border: 'none',
                                                                                                        padding: '5px 15px',
                                                                                                        borderRadius: '4px',
                                                                                                        cursor: 'pointer',
                                                                                                        fontSize: '0.75rem',
                                                                                                        fontWeight: 'bold'
                                                                                                    }}
                                                                                                >
                                                                                                    DELETE
                                                                                                </button>
                                                                                            </div>
                                                                                        </td>
                                                                                    </tr>
                                                                                </React.Fragment>
                                                                            ))}
                                                                        </tbody>
                                                                    </table>
                                                                </div>
                                                            </td>
                                                        </tr>
                                                    )}
                                                </React.Fragment>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    ))}
                </div>
            </main >

            {/* Edit Modal */}
            {
                editModalTx && (
                    <div className="modal-overlay show">
                        <div className="modal">
                            <div className="modal-header">
                                <h3>Edit Transaction</h3>
                                <button className="btn-icon" onClick={() => setEditModalTx(null)}>✕</button>
                            </div>
                            <div className="modal-body">
                                <form onSubmit={handleEditSaved}>
                                    <div className="form-group" style={{ marginBottom: '12px' }}>
                                        <label>Denomination</label>
                                        <input
                                            type="text"
                                            readOnly
                                            value={'₹' + (editModalTx?.denominations?.value || '0')}
                                            style={{ background: '#eee', border: '1px solid #ccc', padding: '8px', width: '100%', boxSizing: 'border-box' }}
                                        />
                                    </div>
                                    <div className="form-group" style={{ marginBottom: '12px' }}>
                                        <label>Notes In</label>
                                        <input
                                            type="number"
                                            min="0"
                                            value={editNotesIn}
                                            onChange={e => setEditNotesIn(e.target.value)}
                                            style={{ padding: '8px', width: '100%', boxSizing: 'border-box', border: '1px solid #ccc', textAlign: 'right' }}
                                        />
                                    </div>
                                    <div className="form-group" style={{ marginBottom: '12px' }}>
                                        <label>Notes Out</label>
                                        <input
                                            type="number"
                                            min="0"
                                            value={editNotesOut}
                                            onChange={e => setEditNotesOut(e.target.value)}
                                            style={{ padding: '8px', width: '100%', boxSizing: 'border-box', border: '1px solid #ccc', textAlign: 'right' }}
                                        />
                                    </div>
                                    <div className="modal-actions" style={{ marginTop: '20px', display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                                        <button type="button" className="btn btn-light" onClick={() => setEditModalTx(null)}>Cancel</button>
                                        <button type="submit" className="btn btn-blue">Save Changes</button>
                                    </div>
                                </form>
                            </div>
                        </div>
                    </div>
                )
            }

            <ToastContainer toasts={toasts} />
        </>
    );
}
