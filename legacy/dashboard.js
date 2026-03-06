/* ============================================================
   Cash Inventory Manager — dashboard.js
   Full application logic: auth guard, data loading,
   realtime subscriptions, transaction CRUD, export
   Light Theme - Single Page layout
   ============================================================ */

'use strict';

// ════════════════════════════════════════════════════════════
// 0. APP STATE
// ════════════════════════════════════════════════════════════
const App = {
    user: null,
    profile: null,
    role: null,           // 'Admin' | 'Cashier' | 'Auditor'
    denominations: [],
    transactions: [],
    audit: [],
    users: [],
    channels: [],

    // In-Memory Form State: maps denomination_id to { notes_in, notes_out }
    formState: {}
};

// ════════════════════════════════════════════════════════════
// 1. UTILITIES
// ════════════════════════════════════════════════════════════
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

function toast(msg, type = 'info') {
    const container = document.getElementById('toastContainer');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span>${msg}</span>`;
    container.appendChild(el);
    setTimeout(() => {
        el.style.opacity = '0';
        el.style.transform = 'translateX(100%)';
        setTimeout(() => el.remove(), 300);
    }, 3500);
}

function updateClock() {
    const now = new Date();
    document.getElementById('clock').textContent = now.toLocaleTimeString('en-US', { hour12: false });
}
setInterval(updateClock, 1000);

// ════════════════════════════════════════════════════════════
// 2. AUTH GUARD & BOOT
// ════════════════════════════════════════════════════════════
async function boot() {
    const { data: { session } } = await _sb.auth.getSession();
    if (!session) { window.location.href = 'index.html'; return; }

    App.user = session.user;

    // Fetch profile & role
    const { data: profile, error: profileErr } = await _sb
        .from('profiles')
        .select('*')
        .eq('id', App.user.id)
        .single();

    if (profileErr || !profile) {
        toast('Could not load your profile. Please contact admin.', 'error');
        return;
    }

    App.profile = profile;
    App.role = profile.role;

    // Render user info
    const email = App.user.email || '';
    document.getElementById('userAvatar').textContent = fmt.initials(email);
    document.getElementById('userAvatar').title = email + " (" + App.role + ")";

    // Initial data load
    await Promise.all([
        loadDenominations(),
        loadTransactions()
    ]);

    updateSummary();

    // Subscribe to realtime
    subscribeRealtime();
    setupEventListeners();
    updateClock();
}

// ════════════════════════════════════════════════════════════
// 3. DATA LOADING
// ════════════════════════════════════════════════════════════
async function loadDenominations() {
    const { data, error } = await _sb
        .from('denominations')
        .select('*')
        .order('sort_order', { ascending: true });

    if (error) { console.error('Denominations error:', error); return; }
    App.denominations = data || [];

    // Initialize form state
    App.denominations.forEach(d => {
        if (!App.formState[d.id]) {
            App.formState[d.id] = { notes_in: 0, notes_out: 0 };
        }
    });

    renderDenomTable();
}

async function loadTransactions() {
    // Note: For history grouped by timestamp, we load normally then group.
    const { data, error } = await _sb
        .from('transactions')
        .select('*, denominations(value, label), profiles(email, full_name)')
        .order('created_at', { ascending: false });

    if (error) { console.error('Transactions error:', error); return; }
    App.transactions = data || [];
    renderHistoryTable();
}

// ════════════════════════════════════════════════════════════
// 4. RENDER DENOMINATION TABLE
// ════════════════════════════════════════════════════════════
function renderDenomTable() {
    const tbody = document.getElementById('denomTableBody');
    const tfoot = document.getElementById('denomTableFoot');

    if (!App.denominations.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center">No denominations configured.</td></tr>';
        tfoot.innerHTML = '';
        return;
    }

    let totalNotesIn = 0;
    let totalNotesOut = 0;
    let totalBalanceValue = 0;

    tbody.innerHTML = App.denominations.map(d => {
        const rowState = App.formState[d.id] || { notes_in: 0, notes_out: 0 };

        // Final stock projection
        const finalStock = d.available + rowState.notes_in - rowState.notes_out;

        // Values
        const netChange = rowState.notes_in - rowState.notes_out;
        const totalValue = finalStock * d.value;
        const netValueStr = netChange !== 0 ? ` ₹${d.value}*${netChange}=${d.value * netChange}` : '';

        totalNotesIn += rowState.notes_in;
        totalNotesOut += rowState.notes_out;
        totalBalanceValue += totalValue;

        return `<tr>
      <td class="text-left"><span class="denom-value">₹${d.value}</span></td>
      <td class="text-center">${fmt.count(d.available)}</td>
      <td class="text-center">
        <input type="number" class="denom-input-in" data-id="${d.id}" value="${rowState.notes_in === 0 ? '' : rowState.notes_in}" min="0" ${App.role === 'Auditor' ? 'disabled' : ''}>
      </td>
      <td class="text-center">
        <input type="number" class="denom-input-out" data-id="${d.id}" value="${rowState.notes_out === 0 ? '' : rowState.notes_out}" min="0" ${App.role === 'Auditor' ? 'disabled' : ''}>
      </td>
      <td class="text-center">
        <span class="calc-text">${netValueStr}</span>
      </td>
      <td class="text-right"><span class="total-value">${fmt.currency(totalValue)}</span></td>
    </tr>`;
    }).join('');

    // Footer totals
    tfoot.innerHTML = `<tr>
    <td class="text-left" colspan="2">TOTAL</td>
    <td class="text-center">${fmt.count(totalNotesIn)}</td>
    <td class="text-center">${fmt.count(totalNotesOut)}</td>
    <td class="text-center"></td>
    <td class="text-right">${fmt.currency(totalBalanceValue)}</td>
  </tr>`;

    // Attach local input listeners
    document.querySelectorAll('.denom-input-in').forEach(input => {
        input.addEventListener('input', handleDenomInput);
        input.addEventListener('keydown', handleDenomKeydown);
    });
    document.querySelectorAll('.denom-input-out').forEach(input => {
        input.addEventListener('input', handleDenomInput);
        input.addEventListener('keydown', handleDenomKeydown);
    });
}

function handleDenomKeydown(e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        saveEntry();
    }
}

function handleDenomInput(e) {
    const isOut = e.target.classList.contains('denom-input-out');
    const id = e.target.dataset.id;
    let val = e.target.value === '' ? 0 : parseInt(e.target.value) || 0;

    if (val < 0) { val = 0; e.target.value = ''; }

    if (isOut) {
        App.formState[id].notes_out = val;
    } else {
        App.formState[id].notes_in = val;
    }

    const focusedClass = isOut ? '.denom-input-out' : '.denom-input-in';

    renderDenomTable();

    // Restore focus 
    const newInput = document.querySelector(`${focusedClass}[data-id="${id}"]`);
    if (newInput) {
        newInput.focus();
    }
}

function clearFields() {
    Object.keys(App.formState).forEach(k => {
        App.formState[k] = { notes_in: 0, notes_out: 0 };
    });
    renderDenomTable();
}

// ════════════════════════════════════════════════════════════
// 5. SUMMARY CARDS
// ════════════════════════════════════════════════════════════
function updateSummary() {
    let totalInVal = 0;
    let totalOutVal = 0;

    for (const tx of App.transactions) {
        const val = tx.denominations?.value || 0;
        totalInVal += tx.notes_in * val;
        totalOutVal += tx.notes_out * val;
    }

    const netBalance = totalInVal - totalOutVal;

    // For the UI, we might want to just show the all-time totals or today's totals.
    // Let's show all-time or depending on requirement. The screenshot shows 200 IN, 0 OUT, 200 NET.
    document.getElementById('summaryTotalIn').textContent = fmt.currency(totalInVal);
    document.getElementById('summaryTotalOut').textContent = fmt.currency(totalOutVal);
    document.getElementById('summaryTotalNet').textContent = fmt.currency(netBalance);
}

// ════════════════════════════════════════════════════════════
// 6. HISTORY TABLE
// ════════════════════════════════════════════════════════════
function renderHistoryTable() {
    const tbody = document.getElementById('historyTableBody');
    if (!App.transactions.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center">No transactions available.</td></tr>';
        return;
    }

    // Since the database creates individual rows per denomination,
    // we should group them by a close timestamp to form a single "Entry" block.
    // Or we show them individually. The screenshot groups them under a master timestamp.

    // Grouping by a 5-second window.
    const groups = [];
    App.transactions.forEach(tx => {
        const tTime = new Date(tx.created_at).getTime();
        let group = groups.find(g => Math.abs(g.time - tTime) < 5000 && g.user_id === tx.user_id && g.note === tx.note);
        if (!group) {
            group = { time: tTime, created_at: tx.created_at, items: [], user_id: tx.user_id, note: tx.note, totalIn: 0, totalOut: 0 };
            groups.push(group);
        }
        group.items.push(tx);
        const val = tx.denominations?.value || 0;
        group.totalIn += tx.notes_in * val;
        group.totalOut += tx.notes_out * val;
    });

    // We'll compute running grand total from bottom (oldest) to top (newest)
    // First reverse so oldest is first
    groups.reverse();
    let currentGrandTotal = 0;
    groups.forEach(g => {
        currentGrandTotal += g.totalIn;
        currentGrandTotal -= g.totalOut;
        g.grandTotal = currentGrandTotal;
    });
    // Reverse back so newest is first
    groups.reverse();

    tbody.innerHTML = groups.map((g, i) => {
        const groupId = `group-${i}`;

        let innerRows = g.items.map(tx => {
            const val = tx.denominations?.value || 0;
            const inAm = tx.notes_in > 0 ? fmt.currency(tx.notes_in * val) : '-';
            const outAm = tx.notes_out > 0 ? fmt.currency(tx.notes_out * val) : '-';

            const adminActions = App.role === 'Admin' || App.role === 'Cashier' ?
                `<button class="btn-icon text-navy" onclick="editTx('${tx.id}')">EDIT</button> 
                 ${App.role === 'Admin' ? `<button class="btn-icon" style="color:var(--red-text)" onclick="deleteTx('${tx.id}')">DELETE</button>` : ''}` : '';

            return `<tr>
                <td>₹${val}</td>
                <td class="amount-positive">${fmt.count(tx.notes_in)}</td>
                <td class="amount-positive">${inAm}</td>
                <td class="amount-negative">${fmt.count(tx.notes_out)}</td>
                <td class="amount-negative">${outAm}</td>
                <td class="text-right">${adminActions}</td>
            </tr>`;
        }).join('');

        const innerTable = `
            <tr id="${groupId}" class="expand-row" style="display:none;">
                <td colspan="5" style="padding:0;">
                    <div class="inner-table">
                        <table>
                            <thead>
                                <tr>
                                    <th class="text-left">DENOMINATION</th>
                                    <th class="text-left">NOTES IN</th>
                                    <th class="text-left">IN AMOUNT</th>
                                    <th class="text-left">NOTES OUT</th>
                                    <th class="text-left">OUT AMOUNT</th>
                                    <th class="text-right"></th>
                                </tr>
                            </thead>
                            <tbody>
                                ${innerRows}
                            </tbody>
                        </table>
                    </div>
                </td>
            </tr>
        `;

        return `
            <tr>
                <td class="text-center">
                    <button class="toggle-btn" onclick="toggleRow('${groupId}', this)">▲</button>
                </td>
                <td>${fmt.datetime(g.created_at)}</td>
                <td class="amount-positive">${fmt.currency(g.totalIn)}</td>
                <td class="amount-negative">${fmt.currency(g.totalOut)}</td>
                <td class="text-navy">${fmt.currency(g.grandTotal)}</td>
            </tr>
            ${innerTable}
        `;
    }).join('');

    // Fix arrow directions for toggle-btn (since they start open in screenshot, let's open the first one)
    setTimeout(() => {
        const firstBtn = tbody.querySelector('.toggle-btn');
        if (firstBtn) firstBtn.click();
    }, 50);
}

window.toggleRow = function (id, btn) {
    const row = document.getElementById(id);
    if (row.style.display === 'none') {
        row.style.display = 'table-row';
        btn.textContent = '▼';
    } else {
        row.style.display = 'none';
        btn.textContent = '▲';
    }
}

// ════════════════════════════════════════════════════════════
// 7. MULTI-TRANSACTION CRUD
// ════════════════════════════════════════════════════════════
async function saveEntry() {
    if (App.role === 'Auditor') { toast('Auditors cannot create transactions.', 'error'); return; }

    const entriesToSave = [];
    for (const [denomId, state] of Object.entries(App.formState)) {
        if (state.notes_in > 0 || state.notes_out > 0) {

            // Validate stock
            const denom = App.denominations.find(d => d.id === denomId);
            if (state.notes_out > denom.available + state.notes_in) {
                toast(`Insufficient stock for ₹${denom.value}.`, 'error');
                return;
            }

            entriesToSave.push({
                user_id: App.user.id,
                denomination_id: denomId,
                notes_in: state.notes_in,
                notes_out: state.notes_out,
                note: 'Bulk entry'
            });
        }
    }

    if (entriesToSave.length === 0) {
        toast('Please enter notes in or out before saving.', 'error');
        return;
    }

    const btn = document.getElementById('saveEntryBtn');
    btn.disabled = true;
    btn.textContent = 'SAVING...';

    const { error } = await _sb.from('transactions').insert(entriesToSave);

    btn.disabled = false;
    btn.textContent = 'SAVE ENTRY';

    if (error) {
        toast('Error: ' + (error.message || 'Could not save transactions.'), 'error');
        return;
    }

    await logAudit(`Added bulk transaction entry`, { count: entriesToSave.length });
    toast('Entry saved successfully!', 'success');
    clearFields();

    await Promise.all([loadTransactions(), loadDenominations()]);
    updateSummary();
}

// ════════════════════════════════════════════════════════════
// 8. INNER ROW CRUD
// ════════════════════════════════════════════════════════════
window.editTx = function (id) {
    const tx = App.transactions.find(t => t.id === id);
    if (!tx) return;

    document.getElementById('editTxId').value = tx.id;
    document.getElementById('editDenomLabel').value = '₹' + (tx.denominations?.value || '0');
    document.getElementById('editNotesIn').value = tx.notes_in;
    document.getElementById('editNotesOut').value = tx.notes_out;

    document.getElementById('editModal').classList.add('show');
}

document.getElementById('closeEditModal').addEventListener('click', () => { document.getElementById('editModal').classList.remove('show'); });
document.getElementById('cancelEditBtn').addEventListener('click', () => { document.getElementById('editModal').classList.remove('show'); });

document.getElementById('editForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('editTxId').value;
    const nIn = parseInt(document.getElementById('editNotesIn').value) || 0;
    const nOut = parseInt(document.getElementById('editNotesOut').value) || 0;

    const { error } = await _sb.from('transactions')
        .update({ notes_in: nIn, notes_out: nOut })
        .eq('id', id);

    if (error) {
        toast('Update failed: ' + error.message, 'error');
    } else {
        toast('Transaction updated', 'success');
        document.getElementById('editModal').classList.remove('show');
        await Promise.all([loadTransactions(), loadDenominations()]);
        updateSummary();
    }
});

window.deleteTx = async function (id) {
    if (!confirm('Are you sure you want to delete this transaction?')) return;

    const { error } = await _sb.from('transactions').delete().eq('id', id);
    if (error) {
        toast('Delete failed: ' + error.message, 'error');
    } else {
        toast('Transaction deleted', 'success');
        await Promise.all([loadTransactions(), loadDenominations()]);
        updateSummary();
    }
}

// ════════════════════════════════════════════════════════════
// 12. AUDIT LOG HELPER
// ════════════════════════════════════════════════════════════
async function logAudit(action, details = {}) {
    await _sb.from('audit_log').insert({
        user_id: App.user.id,
        action,
        details: { ...details, user_email: App.user.email },
    });
}

// ════════════════════════════════════════════════════════════
// 15. REALTIME SUBSCRIPTIONS
// ════════════════════════════════════════════════════════════
function subscribeRealtime() {
    const ch = _sb.channel('public-changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'denominations' }, async () => {
            await loadDenominations();
            updateSummary();
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'transactions' }, async () => {
            await loadTransactions();
            await loadDenominations();
            updateSummary();
        })
        .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                console.log('[Realtime] Connected');
            }
        });

    App.channels.push(ch);
}

// ════════════════════════════════════════════════════════════
// 18. EVENT LISTENERS
// ════════════════════════════════════════════════════════════
function setupEventListeners() {
    document.getElementById('saveEntryBtn').addEventListener('click', saveEntry);
    document.getElementById('clearFieldsBtn').addEventListener('click', clearFields);
}

// ════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════
boot().catch(err => {
    console.error('Boot error:', err);
    toast('Application failed to start. Check console for details.', 'error');
});
