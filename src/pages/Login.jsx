import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { useNavigate } from 'react-router-dom';

export default function Login() {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [loading, setLoading] = useState(false);
    const [errorMsg, setErrorMsg] = useState('');
    const navigate = useNavigate();

    const handleLogin = async (e) => {
        e.preventDefault();
        setErrorMsg('');

        if (!email || !password) {
            setErrorMsg('Please fill in all fields.');
            return;
        }

        setLoading(true);

        const { error } = await supabase.auth.signInWithPassword({
            email,
            password,
        });

        if (error) {
            setErrorMsg(error.message || 'Login failed. Please try again.');
            setLoading(false);
        } else {
            navigate('/dashboard');
        }
    };

    return (
        <div className="login-page">
            {/* Left: Branding Panel */}
            <div className="login-brand">
                <div className="brand-logo">
                    <div className="logo-icon">💰</div>
                    <span>
                        Cash Inventory Manager
                        <small>Multi-user · Realtime · Secure</small>
                    </span>
                </div>

                <div className="brand-headline">
                    <h1>
                        Track every<br />
                        <span className="highlight">rupee,</span><br />
                        in real time.
                    </h1>
                </div>

                <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '28px', maxWidth: '340px' }}>
                    A powerful cash denomination management system for teams. Stay in sync, maintain audit trails, and never lose
                    track of your float.
                </p>

                <ul className="brand-features">
                    <li>
                        <span className="feat-icon">💳</span>
                        Denomination-wise tracking (₹1 – ₹2000)
                    </li>
                    <li>
                        <span className="feat-icon">🔄</span>
                        Realtime multi-user sync via Supabase
                    </li>
                    <li>
                        <span className="feat-icon">🛡️</span>
                        Role-based access: Admin, Cashier, Auditor
                    </li>
                    <li>
                        <span className="feat-icon">📋</span>
                        Full audit trail with timestamps
                    </li>
                    <li>
                        <span className="feat-icon">📊</span>
                        Export transactions to CSV
                    </li>
                </ul>
            </div>

            {/* Right: Login Form */}
            <div className="login-form-panel">
                <div className="login-box">
                    <h2>Welcome back</h2>
                    <p className="subtitle">Sign in to your account to continue</p>

                    {errorMsg && (
                        <div className={`error-message show`} role="alert">
                            {errorMsg}
                        </div>
                    )}

                    <form className="login-form" onSubmit={handleLogin} noValidate>
                        <div className="form-group">
                            <label htmlFor="email">Email address</label>
                            <div className="input-group">
                                <input
                                    type="email"
                                    id="email"
                                    placeholder="you@example.com"
                                    autoComplete="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    required
                                />
                            </div>
                        </div>

                        <div className="form-group">
                            <label htmlFor="password">Password</label>
                            <div className="input-group password-wrap">
                                <input
                                    type={showPassword ? 'text' : 'password'}
                                    id="password"
                                    placeholder="••••••••"
                                    autoComplete="current-password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    required
                                />
                                <button
                                    type="button"
                                    className="toggle-password"
                                    onClick={() => setShowPassword(!showPassword)}
                                    aria-label="Toggle password visibility"
                                >
                                    {showPassword ? '🙈' : '👁'}
                                </button>
                            </div>
                        </div>

                        <button type="submit" className="btn btn-primary" disabled={loading}>
                            <span>{loading ? 'Signing in…' : 'Sign In'}</span>
                        </button>
                    </form>

                    <div className="login-footer">
                        <p>Contact your administrator to create an account.</p>
                    </div>
                </div>
            </div>
        </div>
    );
}
