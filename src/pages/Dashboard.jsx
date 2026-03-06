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
            setClock(new Date().toLocaleTimeString('en-US', { hour12: false }));
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
                if (state.notes_out > denom.available + state.notes_in) {
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

    // History Grouping
    const groups = [];
    transactions.forEach(tx => {
        const tTime = new Date(tx.created_at).getTime();
        let group = groups.find(g => Math.abs(g.time - tTime) < 5000 && g.user_id === tx.user_id && g.note === tx.note);
        if (!group) {
            group = { time: tTime, created_at: tx.created_at, items: [], user_id: tx.user_id, note: tx.note, totalIn: 0, totalOut: 0, isExpanded: false, id: `group-${tTime}` };
            groups.push(group);
        }
        group.items.push(tx);
        const val = tx.denominations?.value || 0;
        group.totalIn += tx.notes_in * val;
        group.totalOut += tx.notes_out * val;
    });

    groups.reverse();
    let currentGrandTotal = 0;
    groups.forEach(g => {
        currentGrandTotal += g.totalIn;
        currentGrandTotal -= g.totalOut;
        g.grandTotal = currentGrandTotal;
    });
    groups.reverse();

    // History toggle state
    const [expandedGroups, setExpandedGroups] = useState({});
    useEffect(() => {
        if (groups.length > 0 && Object.keys(expandedGroups).length === 0) {
            setExpandedGroups({ [groups[0].id]: true });
        }
    }, [groups, expandedGroups]);

    const toggleGroup = (id) => {
        setExpandedGroups(prev => ({ ...prev, [id]: !prev[id] }));
    };

    if (loading) {
        return <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center' }}>Loading dashboard...</div>;
    }

    return (
        <>
            <header className="topbar">
                <div className="topbar-left">
                    <span className="logo">💰</span>
                    <h1>Cash Inventory Manager</h1>
                </div>
                <div className="topbar-right">
                    <div className="user-avatar" title={`${session.user.email} (${role})`} onClick={handleLogout}>
                        {fmt.initials(session.user.email)}
                    </div>
                    <div className="clock">{clock}</div>
                </div>
            </header>

            <main className="main-container">
                {/* Summary Cards */}
                <div className="summary-cards">
                    <div className="card">
                        <div className="card-label">TOTAL IN (+)</div>
                        <div className="card-value value-green" id="summaryTotalIn">
                            {fmt.currency(totalInVal + uiTotalInValue)}
                            {uiTotalInValue > 0 && (
                                <div style={{ fontSize: '0.75rem', fontWeight: 500, marginTop: '4px', opacity: 0.9 }}>
                                    New: {fmt.currency(uiTotalInValue)} (N * NOTES IN)
                                </div>
                            )}
                        </div>
                    </div>
                    <div className="card">
                        <div className="card-label">TOTAL OUT (-)</div>
                        <div className="card-value value-red" id="summaryTotalOut">
                            {fmt.currency(totalOutVal + uiTotalOutValue)}
                            {uiTotalOutValue > 0 && (
                                <div style={{ fontSize: '0.75rem', fontWeight: 500, marginTop: '4px', opacity: 0.9 }}>
                                    New: {fmt.currency(uiTotalOutValue)} (N * NOTES OUT)
                                </div>
                            )}
                        </div>
                    </div>
                    <div className="card">
                        <div className="card-label">NET MOVEMENT</div>
                        <div className="card-value value-navy" id="summaryTotalNet">
                            {fmt.currency((totalInVal + uiTotalInValue) - (totalOutVal + uiTotalOutValue))}
                        </div>
                    </div>
                </div>

                {/* Form */}
                <div className="table-container">
                    <table className="data-table input-table">
                        <thead>
                            <tr>
                                <th className="text-left" style={{ width: '80px' }}>N</th>
                                <th className="text-center">AVAILABLE</th>
                                <th className="text-center">NOTES IN (+)</th>
                                <th className="text-center">NOTES OUT (-)</th>
                                <th className="text-center">FINAL STOCK</th>
                                <th className="text-right">TOTAL VALUE</th>
                            </tr>
                        </thead>
                        <tbody>
                            {denominations.length === 0 && (
                                <tr>
                                    <td colSpan="6" className="text-center">No denominations configured.</td>
                                </tr>
                            )}
                            {denominations.map(d => {
                                const rowState = formState[d.id] || { notes_in: 0, notes_out: 0 };
                                const finalStock = d.available + rowState.notes_in - rowState.notes_out;
                                const netChange = rowState.notes_in - rowState.notes_out;
                                const totalValue = finalStock * d.value;
                                const netValueStr = netChange !== 0 ? ` ₹${d.value}*${netChange}=${d.value * netChange}` : '';

                                uiTotalNotesIn += rowState.notes_in;
                                uiTotalInValue += rowState.notes_in * d.value;
                                uiTotalNotesOut += rowState.notes_out;
                                uiTotalOutValue += rowState.notes_out * d.value;
                                uiTotalFinalStock += finalStock;
                                uiTotalBalanceValue += totalValue;

                                return (
                                    <tr key={d.id}>
                                        <td className="text-left"><span className="denom-value">₹{d.value}</span></td>
                                        <td className="text-center">{fmt.count(d.available)}</td>
                                        <td className="text-center" style={{ minWidth: '160px' }}>
                                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                                                <input
                                                    type="number"
                                                    className="compact-input"
                                                    value={rowState.notes_in === 0 ? '' : rowState.notes_in}
                                                    min="0"
                                                    disabled={role === 'Auditor'}
                                                    placeholder="0"
                                                    onChange={(e) => handleDenomChange(d.id, 'notes_in', e.target.value)}
                                                    onKeyDown={(e) => e.key === 'Enter' && handleSaveEntry()}
                                                    style={{ width: '100px', textAlign: 'right' }}
                                                />
                                                {rowState.notes_in > 0 && (
                                                    <span className="calc-text" style={{ fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
                                                        {d.value} * {rowState.notes_in} = {fmt.currency(rowState.notes_in * d.value)}
                                                    </span>
                                                )}
                                            </div>
                                        </td>
                                        <td className="text-center" style={{ minWidth: '160px' }}>
                                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                                                <input
                                                    type="number"
                                                    className="compact-input"
                                                    value={rowState.notes_out === 0 ? '' : rowState.notes_out}
                                                    min="0"
                                                    disabled={role === 'Auditor'}
                                                    placeholder="0"
                                                    onChange={(e) => handleDenomChange(d.id, 'notes_out', e.target.value)}
                                                    onKeyDown={(e) => e.key === 'Enter' && handleSaveEntry()}
                                                    style={{ width: '100px', textAlign: 'right' }}
                                                />
                                                {rowState.notes_out > 0 && (
                                                    <span className="calc-text-red" style={{ fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
                                                        {d.value} * {rowState.notes_out} = {fmt.currency(rowState.notes_out * d.value)}
                                                    </span>
                                                )}
                                            </div>
                                        </td>
                                        <td className="text-center">
                                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                                                <span style={{
                                                    fontWeight: 600,
                                                    color: rowState.notes_in > 0 ? 'var(--green-text)' : rowState.notes_out > 0 ? 'var(--red-text)' : 'inherit'
                                                }}>
                                                    {fmt.count(finalStock)}
                                                </span>
                                                <span className="calc-text" style={{ fontSize: '0.7rem', color: '#666' }}>{netValueStr}</span>
                                            </div>
                                        </td>
                                        <td className="text-right"><span className="total-value">{fmt.currency(totalValue)}</span></td>
                                    </tr>
                                )
                            })}
                        </tbody>
                        <tfoot>
                            <tr>
                                <td className="text-left" colSpan="2">TOTAL</td>
                                <td className="text-center">
                                    <div style={{ fontWeight: 'bold' }}>{fmt.count(uiTotalNotesIn)}</div>
                                    <div className="amount-positive" style={{ fontSize: '0.8rem' }}>{fmt.currency(uiTotalInValue)}</div>
                                </td>
                                <td className="text-center">
                                    <div style={{ fontWeight: 'bold' }}>{fmt.count(uiTotalNotesOut)}</div>
                                    <div className="amount-negative" style={{ fontSize: '0.8rem' }}>{fmt.currency(uiTotalOutValue)}</div>
                                </td>
                                <td className="text-center" style={{ fontWeight: 'bold' }}>{fmt.count(uiTotalFinalStock)}</td>
                                <td className="text-right">{fmt.currency(uiTotalBalanceValue)}</td>
                            </tr>
                        </tfoot>
                    </table>
                </div>

                {/* Action Buttons */}
                <div className="form-actions">
                    <button className="btn btn-navy" onClick={handleSaveEntry} disabled={saving}>
                        {saving ? 'SAVING...' : 'SAVE ENTRY'}
                    </button>
                    <button className="btn btn-light" onClick={handleClearFields}>CLEAR FIELDS</button>
                </div>

                <div className="section-title">
                    <h2>Transaction History</h2>
                </div>

                <div className="table-container">
                    <table className="data-table history-table">
                        <thead>
                            <tr>
                                <th className="text-left" style={{ width: '40px' }}></th>
                                <th className="text-left">TIMESTAMP</th>
                                <th className="text-left">TOTAL IN</th>
                                <th className="text-left">TOTAL OUT</th>
                                <th className="text-left">GRAND TOTAL</th>
                            </tr>
                        </thead>
                        <tbody>
                            {groups.length === 0 ? (
                                <tr>
                                    <td colSpan="5" className="text-center">No transactions available.</td>
                                </tr>
                            ) : groups.map(g => {
                                const isExpanded = expandedGroups[g.id];

                                return (
                                    <React.Fragment key={g.id}>
                                        <tr>
                                            <td className="text-center">
                                                <button className="toggle-btn" onClick={() => toggleGroup(g.id)}>
                                                    {isExpanded ? '▼' : '▲'}
                                                </button>
                                            </td>
                                            <td>{fmt.datetime(g.created_at)}</td>
                                            <td className="amount-positive">{fmt.currency(g.totalIn)}</td>
                                            <td className="amount-negative">{fmt.currency(g.totalOut)}</td>
                                            <td className="text-navy">{fmt.currency(g.grandTotal)}</td>
                                        </tr>
                                        {isExpanded && (
                                            <tr className="expand-row">
                                                <td colSpan="5" style={{ padding: 0 }}>
                                                    <div className="inner-table">
                                                        <table>
                                                            <thead>
                                                                <tr>
                                                                    <th className="text-left">DENOMINATION</th>
                                                                    <th className="text-left">NOTES IN</th>
                                                                    <th className="text-left">IN AMOUNT</th>
                                                                    <th className="text-left">NOTES OUT</th>
                                                                    <th className="text-left">OUT AMOUNT</th>
                                                                    <th className="text-right"></th>
                                                                </tr>
                                                            </thead>
                                                            <tbody>
                                                                {g.items.map(tx => {
                                                                    const val = tx.denominations?.value || 0;
                                                                    const inAm = tx.notes_in > 0 ? `₹${val}*${tx.notes_in}=${tx.notes_in * val}` : '-';
                                                                    const outAm = tx.notes_out > 0 ? `₹${val}*${tx.notes_out}=${tx.notes_out * val}` : '-';

                                                                    return (
                                                                        <tr key={tx.id}>
                                                                            <td>₹{val}</td>
                                                                            <td className="amount-positive">{fmt.count(tx.notes_in)}</td>
                                                                            <td className="amount-positive">{inAm}</td>
                                                                            <td className="amount-negative">{fmt.count(tx.notes_out)}</td>
                                                                            <td className="amount-negative">{outAm}</td>
                                                                            <td className="text-right">
                                                                                {(role === 'Admin' || role === 'Cashier') && (
                                                                                    <button
                                                                                        className="btn-icon text-navy"
                                                                                        onClick={() => {
                                                                                            setEditModalTx(tx);
                                                                                            setEditNotesIn(tx.notes_in);
                                                                                            setEditNotesOut(tx.notes_out);
                                                                                        }}
                                                                                    >
                                                                                        EDIT
                                                                                    </button>
                                                                                )}
                                                                                {role === 'Admin' && (
                                                                                    <button
                                                                                        className="btn-icon"
                                                                                        style={{ color: 'var(--red-text)' }}
                                                                                        onClick={() => handleDelete(tx.id)}
                                                                                    >
                                                                                        DELETE
                                                                                    </button>
                                                                                )}
                                                                            </td>
                                                                        </tr>
                                                                    )
                                                                })}
                                                            </tbody>
                                                        </table>
                                                    </div>
                                                </td>
                                            </tr>
                                        )}
                                    </React.Fragment>
                                )
                            })}
                        </tbody>
                    </table>
                </div>
            </main>

            {/* Edit Modal */}
            {editModalTx && (
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
            )}

            <ToastContainer toasts={toasts} />
        </>
    );
}
