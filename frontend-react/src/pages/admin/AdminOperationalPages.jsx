import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Badge from '../../components/Badge';
import { ConfirmDialog, DataTable, FormField, Modal, useToast } from '../../components/ui';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { normalizeError } from '../../api/errors';
import { adminApi } from '../../api/admin';
import { purchaseOrdersApi } from '../../api/resources';
import { formatDate, formatDateTime, formatPaise } from '../../utils/format';
import LabTestCreateForm from '../shared/LabTestCreateForm';

const PAGE_SIZE = 200;

const auditLogApi = { list: adminApi.auditLog };
const departmentsApi = { list: adminApi.departments, create: (data) => adminApi.create('departments', data), update: (id, data) => adminApi.update('departments', id, data) };
const labCatalogApi = { list: adminApi.labCatalog, create: (data) => adminApi.create('lab-catalog', data), update: (id, data) => adminApi.update('lab-catalog', id, data) };
const reportsApi = { generate: adminApi.reports };
const settingsApi = { list: adminApi.settings, update: adminApi.updateSettings };
const suppliersApi = { list: adminApi.suppliers, create: (data) => adminApi.create('suppliers', data), update: (id, data) => adminApi.update('suppliers', id, data), rates: adminApi.supplierRates };
const usersApi = { list: adminApi.users, resetPassword: adminApi.resetPassword, unlock: adminApi.unlock };

async function fetchAllPages(list, params = {}) {
  const rows = [];
  let page = 1;
  while (true) {
    const response = await list({ ...params, page, page_size: PAGE_SIZE });
    if (Array.isArray(response)) return page === 1 ? response : rows.concat(response);
    if (!response || !Array.isArray(response.results)) {
      throw new Error('The API returned an unexpected paginated response.');
    }
    rows.push(...response.results);
    if (!response.next) return rows;
    page += 1;
  }
}

function PageHeader({ title, subtitle }) {
  return (
    <div className="page-header">
      <div className="page-header__info">
        <h1 className="text-page-title">{title}</h1>
        {subtitle && <p className="text-caption">{subtitle}</p>}
      </div>
    </div>
  );
}

function FilterBar({ children }) {
  return (
    <section className="glass card" style={{ padding: '1rem', marginBottom: '1rem' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem', alignItems: 'end' }}>
        {children}
      </div>
    </section>
  );
}

function errorMessage(error) {
  return normalizeError(error).message || 'The request failed. Please try again.';
}

function labCatalogErrors(error) {
  const responseErrors = error?.response?.data || {};
  const fields = {};
  let form = '';
  const messageText = (value) => Array.isArray(value) ? value.join(' ') : typeof value === 'string' ? value : '';
  for (const key of ['name', 'code', 'category', 'sampleType', 'turnaroundHrs', 'price', 'description']) {
    if (responseErrors[key]) fields[key] = messageText(responseErrors[key]);
  }
  if (Array.isArray(responseErrors.parameters)) {
    responseErrors.parameters.forEach((parameterErrors, index) => {
      if (!parameterErrors || typeof parameterErrors !== 'object' || Array.isArray(parameterErrors)) {
        form ||= messageText(parameterErrors);
        return;
      }
      for (const [key, value] of Object.entries(parameterErrors)) {
        if (value) fields[`parameters.${index}.${key}`] = messageText(value);
      }
    });
  } else if (responseErrors.parameters) {
    form = messageText(responseErrors.parameters);
  }
  form ||= messageText(responseErrors.detail) || errorMessage(error);
  return { fields, form };
}

function roleLabel(role, roleRows = []) {
  return roleRows.find((item) => item.code === role)?.name
    || ({ ADMIN: 'Administrator', DOCTOR: 'Doctor', RECEPTIONIST: 'Receptionist', PHARMACIST: 'Pharmacist', LAB_TECH: 'Lab Technician' })[role]
    || role || '—';
}

function accountStatus(user) {
  if (!user.isActive) return { label: 'Disabled', status: 'INACTIVE' };
  if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) return { label: 'Locked', status: 'CANCELLED' };
  return { label: 'Active', status: 'ACTIVE' };
}

export function AdminUsersPage() {
  const client = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState(() => new URLSearchParams(window.location.search).get('search') || '');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [resetUser, setResetUser] = useState(null);
  const [unlockUser, setUnlockUser] = useState(null);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const rolesQuery = useQuery({ queryKey: ['adminRoles'], queryFn: adminApi.roles });

  const usersQuery = useQuery({ queryKey: ['adminUsers'], queryFn: () => fetchAllPages(usersApi.list) });
  const resetMutation = useMutation({
    mutationFn: ({ id, nextPassword, confirm }) => usersApi.resetPassword(id, nextPassword, confirm),
    onSuccess: async () => {
      toast.success('Password reset successfully.');
      setResetUser(null);
      setPassword('');
      setConfirmPassword('');
      setPasswordError('');
      await client.invalidateQueries({ queryKey: ['adminUsers'] });
    },
    onError: (error) => setPasswordError(normalizeError(error).fieldErrors?.password?.join(' ') || errorMessage(error)),
  });
  const unlockMutation = useMutation({
    mutationFn: (id) => usersApi.unlock(id),
    onSuccess: async () => {
      toast.success('Account unlocked.');
      setUnlockUser(null);
      await client.invalidateQueries({ queryKey: ['adminUsers'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const rows = useMemo(() => (usersQuery.data || []).filter((user) => {
    const q = search.trim().toLowerCase();
    const matchesSearch = !q || [user.username, user.staffName, user.staffEmail, user.staffId, user.role, roleLabel(user.role, rolesQuery.data)].some((value) => String(value || '').toLowerCase().includes(q));
    const matchesRole = !roleFilter || user.role === roleFilter;
    const state = accountStatus(user).label.toLowerCase();
    const matchesStatus = !statusFilter || state === statusFilter;
    return matchesSearch && matchesRole && matchesStatus;
  }), [usersQuery.data, search, roleFilter, statusFilter, rolesQuery.data]);

  const columns = useMemo(() => [
    { key: 'username', label: 'Username', sortable: true, render: (row) => <strong>{row.username}</strong> },
    { key: 'staffName', label: 'Staff Member', sortable: true, render: (row) => row.staffName || row.staffId || '—' },
    { key: 'role', label: 'Role', sortable: true, render: (row) => roleLabel(row.role, rolesQuery.data) },
    { key: 'lastLogin', label: 'Last Login', sortable: true, render: (row) => formatDateTime(row.lastLogin) },
    { key: 'accountState', label: 'Status', render: (row) => <Badge status={accountStatus(row).status}>{accountStatus(row).label}</Badge> },
    { key: 'failedAttempts', label: 'Failed Attempts', render: (row) => row.failedAttempts ?? 0 },
    { key: 'actions', label: 'Actions', render: (row) => (
      <div className="table-actions">
        <button type="button" className="btn btn--secondary btn--sm" onClick={() => { setResetUser(row); setPassword(''); setConfirmPassword(''); setPasswordError(''); }}>Reset Password</button>
        {accountStatus(row).label === 'Locked' && <button type="button" className="btn btn--primary btn--sm" onClick={() => setUnlockUser(row)}>Unlock</button>}
      </div>
    ) },
  ], [rolesQuery.data]);

  const submitReset = (event) => {
    event.preventDefault();
    if (!password) return setPasswordError('Enter a new password.');
    if (password !== confirmPassword) return setPasswordError('Passwords do not match.');
    resetMutation.mutate({ id: resetUser.id, nextPassword: password, confirm: confirmPassword });
  };

  return (
    <div>
      <PageHeader title="User Accounts" subtitle="Review login status, reset passwords, and unlock locked accounts." />
      <FilterBar>
        <FormField label="Search accounts" htmlFor="user-search"><input id="user-search" className="form-control" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Username, staff member, email or ID" /></FormField>
        <FormField label="Role" htmlFor="user-role-filter"><select id="user-role-filter" className="form-control" value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}><option value="">All roles</option>{(rolesQuery.data || []).map((role) => <option key={role.code} value={role.code}>{role.name}</option>)}</select></FormField>
        <FormField label="Status" htmlFor="user-status-filter"><select id="user-status-filter" className="form-control" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">All statuses</option><option value="active">Active</option><option value="locked">Locked</option><option value="disabled">Disabled</option></select></FormField>
        <button type="button" className="btn btn--ghost" onClick={() => { setSearch(''); setRoleFilter(''); setStatusFilter(''); }}>Reset filters</button>
      </FilterBar>
      {usersQuery.isLoading ? <LoadingState message="Loading user accounts..." /> : usersQuery.error ? <ErrorState title="Unable to load accounts" error={usersQuery.error} onRetry={usersQuery.refetch} /> : rows.length === 0 ? <EmptyState title={usersQuery.data?.length ? 'No matching accounts' : 'No user accounts'} description={usersQuery.data?.length ? 'Try changing or clearing the filters.' : 'There are no login accounts to display.'} icon="icon-key" /> : <section className="glass card" style={{ padding: '1rem' }}><DataTable columns={columns} data={rows} perPage={10} /></section>}

      <Modal isOpen={Boolean(resetUser)} onClose={() => !resetMutation.isPending && setResetUser(null)} title={resetUser ? `Reset password for ${resetUser.username}` : 'Reset password'}>
        <form id="admin-reset-password" onSubmit={submitReset} noValidate>
          <p className="text-caption">Set a new password for this account. The server validates it against the configured password rules.</p>
          {passwordError && <p role="alert" style={{ color: 'var(--danger)' }}>{passwordError}</p>}
          <FormField label="New password" htmlFor="user-new-password" required><input id="user-new-password" className="form-control" type="password" autoComplete="new-password" value={password} onChange={(event) => { setPassword(event.target.value); setPasswordError(''); }} required /></FormField>
          <FormField label="Confirm new password" htmlFor="user-confirm-password" required><input id="user-confirm-password" className="form-control" type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => { setConfirmPassword(event.target.value); setPasswordError(''); }} required /></FormField>
        </form>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '1rem' }}>
          <button type="button" className="btn btn--secondary" onClick={() => setResetUser(null)} disabled={resetMutation.isPending}>Cancel</button>
          <button type="submit" form="admin-reset-password" className="btn btn--primary" disabled={resetMutation.isPending}>{resetMutation.isPending ? 'Saving…' : 'Confirm Reset'}</button>
        </div>
      </Modal>
      <ConfirmDialog isOpen={Boolean(unlockUser)} onClose={() => !unlockMutation.isPending && setUnlockUser(null)} onConfirm={() => unlockUser && unlockMutation.mutate(unlockUser.id)} title="Unlock account?" message={unlockUser ? `Clear the failed-login lock for ${unlockUser.username}?` : ''} confirmLabel="Unlock" isLoading={unlockMutation.isPending} />
    </div>
  );
}

const EMPTY_DEPARTMENT = { name: '', code: '', description: '', defaultFeeRupees: '', headDoctorId: '', isBookable: true, isActive: true };

export function AdminDepartmentsPage() {
  const client = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [form, setForm] = useState(EMPTY_DEPARTMENT);
  const [editingId, setEditingId] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [formError, setFormError] = useState('');
  const departmentQuery = useQuery({ queryKey: ['adminDepartments'], queryFn: () => fetchAllPages(departmentsApi.list) });
  const doctorsQuery = useQuery({ queryKey: ['adminDepartmentDoctors'], queryFn: () => fetchAllPages(adminApi.staff, { role: 'DOCTOR' }) });
  const saveMutation = useMutation({
    mutationFn: ({ id, data }) => id ? departmentsApi.update(id, data) : departmentsApi.create(data),
    onSuccess: async (_data, vars) => { toast.success(vars.id ? 'Department updated.' : 'Department created.'); setFormOpen(false); setFormError(''); await client.invalidateQueries({ queryKey: ['adminDepartments'] }); },
    onError: (error) => setFormError(errorMessage(error)),
  });
  const visibleRows = useMemo(() => (departmentQuery.data || []).filter((row) => {
    const q = search.trim().toLowerCase();
    return (!q || [row.name, row.code, row.headDoctorName].some((value) => String(value || '').toLowerCase().includes(q)))
      && (!statusFilter || String(Boolean(row.isActive)) === statusFilter);
  }), [departmentQuery.data, search, statusFilter]);
  const columns = useMemo(() => [
    { key: 'name', label: 'Department', sortable: true, render: (row) => <strong>{row.name}</strong> },
    { key: 'code', label: 'Code', sortable: true, render: (row) => row.code || '—' },
    { key: 'headDoctorName', label: 'Head Doctor', sortable: true, render: (row) => row.headDoctorName || '—' },
    { key: 'defaultFee', label: 'Consultation Fee', sortable: true, render: (row) => formatPaise(row.defaultFee) },
    { key: 'isBookable', label: 'Bookings', render: (row) => <Badge status={row.isBookable ? 'ACTIVE' : 'INACTIVE'}>{row.isBookable ? 'Bookable' : 'Not bookable'}</Badge> },
    { key: 'isActive', label: 'Status', render: (row) => <Badge status={row.isActive ? 'ACTIVE' : 'INACTIVE'}>{row.isActive ? 'Active' : 'Inactive'}</Badge> },
    { key: 'actions', label: 'Actions', render: (row) => <button type="button" className="btn btn--secondary btn--sm" onClick={() => { setEditingId(row.id); setForm({ name: row.name || '', code: row.code || '', description: row.description || '', defaultFeeRupees: (Number(row.defaultFee || 0) / 100).toFixed(2), headDoctorId: row.headDoctorId || '', isBookable: Boolean(row.isBookable), isActive: Boolean(row.isActive) }); setFormError(''); setFormOpen(true); }}>Edit</button> },
  ], []);
  const openCreate = () => { setEditingId(''); setForm({ ...EMPTY_DEPARTMENT }); setFormError(''); setFormOpen(true); };
  const submit = (event) => {
    event.preventDefault();
    const fee = Number(form.defaultFeeRupees);
    if (!form.name.trim()) return setFormError('Enter a department name.');
    if (form.code.length > 15) return setFormError('Department code must be 15 characters or fewer.');
    if (!Number.isFinite(fee) || fee < 0) return setFormError('Enter a valid non-negative consultation fee.');
    saveMutation.mutate({ id: editingId || null, data: { name: form.name.trim(), code: form.code.trim() || null, description: form.description.trim(), defaultFee: Math.round(fee * 100), headDoctorIdInput: form.headDoctorId, isBookable: form.isBookable, isActive: form.isActive } });
  };
  return (
    <div>
      <PageHeader title="Clinical Departments" subtitle="Manage departments and their consultation fees." />
      <div className="page-header__actions" style={{ marginBottom: '1rem' }}><button type="button" className="btn btn--primary" onClick={openCreate}>Add Department</button></div>
      <FilterBar>
        <FormField label="Search departments" htmlFor="department-search"><input id="department-search" className="form-control" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, code or head doctor" /></FormField>
        <FormField label="Status" htmlFor="department-status"><select id="department-status" className="form-control" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">All departments</option><option value="true">Active</option><option value="false">Inactive</option></select></FormField>
        <button type="button" className="btn btn--ghost" onClick={() => { setSearch(''); setStatusFilter(''); }}>Reset filters</button>
      </FilterBar>
      {departmentQuery.isLoading ? <LoadingState message="Loading departments..." /> : departmentQuery.error ? <ErrorState title="Unable to load departments" error={departmentQuery.error} onRetry={departmentQuery.refetch} /> : visibleRows.length === 0 ? <EmptyState title={departmentQuery.data?.length ? 'No matching departments' : 'No departments configured'} description={departmentQuery.data?.length ? 'Try changing the search or status filter.' : 'Create a department to get started.'} icon="icon-building" action={!departmentQuery.data?.length && <button type="button" className="btn btn--primary" onClick={openCreate}>Add Department</button>} /> : <section className="glass card" style={{ padding: '1rem' }}><DataTable columns={columns} data={visibleRows} perPage={10} /></section>}
      <Modal isOpen={formOpen} onClose={() => !saveMutation.isPending && setFormOpen(false)} title={editingId ? 'Edit Department' : 'Add Department'} size="lg">
        <form id="department-form" onSubmit={submit} noValidate>
          {formError && <p role="alert" style={{ color: 'var(--danger)' }}>{formError}</p>}
          <div className="form-grid">
            <FormField label="Department name" htmlFor="department-name" required><input id="department-name" className="form-control" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} maxLength={100} required /></FormField>
            <FormField label="Code" htmlFor="department-code" hint="Optional; must be unique."><input id="department-code" className="form-control" value={form.code} onChange={(event) => setForm({ ...form, code: event.target.value })} maxLength={15} /></FormField>
            <FormField label="Consultation fee (₹)" htmlFor="department-fee" required><input id="department-fee" type="number" min="0" step="0.01" className="form-control" value={form.defaultFeeRupees} onChange={(event) => setForm({ ...form, defaultFeeRupees: event.target.value })} required /></FormField>
            <FormField label="Description" htmlFor="department-description"><input id="department-description" className="form-control" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} maxLength={255} /></FormField>
            <FormField label="Head doctor" htmlFor="department-head-doctor" error={doctorsQuery.error ? 'Doctor list could not be loaded.' : undefined} hint="Select an existing staff member with the Doctor role.">
              <select id="department-head-doctor" className="form-control" value={form.headDoctorId} onChange={(event) => setForm({ ...form, headDoctorId: event.target.value })} disabled={doctorsQuery.isLoading || Boolean(doctorsQuery.error)}>
                <option value="">No head doctor assigned</option>
                {(doctorsQuery.data || []).map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.name}{doctor.designation ? ` - ${doctor.designation}` : ''}{doctor.isActive ? '' : ' (Inactive)'}</option>)}
              </select>
              {doctorsQuery.error && <button type="button" className="btn btn--ghost btn--sm" onClick={() => doctorsQuery.refetch()}>Retry doctor list</button>}
              {doctorsQuery.isLoading && <span className="text-caption">Loading doctors...</span>}
              {!doctorsQuery.isLoading && !doctorsQuery.error && doctorsQuery.data?.length === 0 && <span className="text-caption">No doctor records are available yet.</span>}
            </FormField>
            <label className="form-check"><input type="checkbox" checked={form.isBookable} onChange={(event) => setForm({ ...form, isBookable: event.target.checked })} /> Allow patient bookings</label>
            <label className="form-check"><input type="checkbox" checked={form.isActive} onChange={(event) => setForm({ ...form, isActive: event.target.checked })} /> Active</label>
          </div>
          <p className="text-caption">The head doctor must already exist in Staff Management with the Doctor role. Leave it unassigned to clear the current head doctor.</p>
        </form>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '1rem' }}><button type="button" className="btn btn--secondary" onClick={() => setFormOpen(false)} disabled={saveMutation.isPending}>Cancel</button><button type="submit" form="department-form" className="btn btn--primary" disabled={saveMutation.isPending}>{saveMutation.isPending ? 'Saving…' : 'Save Department'}</button></div>
      </Modal>
    </div>
  );
}

export function AdminLabCatalogPage() {
  const client = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [editing, setEditing] = useState(null);
  const [price, setPrice] = useState('');
  const [formError, setFormError] = useState('');
  const [labTestForm, setLabTestForm] = useState(null);
  const [labTestFormError, setLabTestFormError] = useState('');
  const [labTestFieldErrors, setLabTestFieldErrors] = useState({});
  const catalogQuery = useQuery({ queryKey: ['adminLabCatalog'], queryFn: () => fetchAllPages(labCatalogApi.list) });
  const priceMutation = useMutation({
    mutationFn: ({ id, value }) => labCatalogApi.update(id, { price: value }),
    onSuccess: async () => { toast.success('Lab test price updated.'); setEditing(null); await client.invalidateQueries({ queryKey: ['adminLabCatalog'] }); },
    onError: (error) => setFormError(errorMessage(error)),
  });
  const saveMutation = useMutation({
    mutationFn: ({ id, data }) => id ? labCatalogApi.update(id, data) : labCatalogApi.create(data),
    onSuccess: async (_data, variables) => { toast.success(variables.id ? 'Lab test updated.' : 'Lab test added.'); setLabTestForm(null); setLabTestFormError(''); setLabTestFieldErrors({}); await Promise.all([client.invalidateQueries({ queryKey: ['adminLabCatalog'] }), client.invalidateQueries({ queryKey: ['labCatalog'] }), client.invalidateQueries({ queryKey: ['doctorLabCatalog'] })]); },
    onError: (error) => { const mapped = labCatalogErrors(error); setLabTestFormError(mapped.form); setLabTestFieldErrors(mapped.fields); toast.error(mapped.form); },
  });
  const labTestStatusMutation = useMutation({
    mutationFn: ({ test }) => labCatalogApi.update(test.id, { isActive: !test.isActive }),
    onSuccess: async (_data, { test }) => { toast.success(`Lab test ${test.isActive ? 'deactivated' : 'activated'}.`); await Promise.all([client.invalidateQueries({ queryKey: ['adminLabCatalog'] }), client.invalidateQueries({ queryKey: ['labCatalog'] }), client.invalidateQueries({ queryKey: ['doctorLabCatalog'] })]); },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const categories = useMemo(() => [...new Set((catalogQuery.data || []).map((row) => row.category).filter(Boolean))].sort(), [catalogQuery.data]);
  const rows = useMemo(() => (catalogQuery.data || []).filter((row) => {
    const q = search.trim().toLowerCase();
    return (!q || [row.name, row.code, row.category, row.sampleType].some((value) => String(value || '').toLowerCase().includes(q)))
      && (!category || row.category === category)
      && (!statusFilter || String(Boolean(row.isActive)) === statusFilter);
  }), [catalogQuery.data, search, category, statusFilter]);
  const columns = useMemo(() => [
    { key: 'code', label: 'Code', sortable: true, render: (row) => row.code || '—' },
    { key: 'name', label: 'Test Name', sortable: true, render: (row) => <strong>{row.name}</strong> },
    { key: 'category', label: 'Category', sortable: true, render: (row) => row.category || '—' },
    { key: 'sampleType', label: 'Sample', render: (row) => row.sampleType || '—' },
    { key: 'turnaroundHrs', label: 'Turnaround', render: (row) => `${row.turnaroundHrs ?? '—'} hrs` },
    { key: 'parameters', label: 'Parameters', render: (row) => Array.isArray(row.parameters) ? row.parameters.map((parameter) => parameter.name).filter(Boolean).join(', ') || '—' : '—' },
    { key: 'price', label: 'Price', sortable: true, render: (row) => formatPaise(row.price) },
    { key: 'isActive', label: 'Status', render: (row) => <Badge status={row.isActive ? 'ACTIVE' : 'INACTIVE'}>{row.isActive ? 'Active' : 'Inactive'}</Badge> },
    { key: 'actions', label: 'Actions', render: (row) => <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}><button type="button" className="btn btn--secondary btn--sm" onClick={() => { setLabTestForm({ mode: 'edit', test: row }); setLabTestFormError(''); setLabTestFieldErrors({}); }}>Edit</button><button type="button" className="btn btn--secondary btn--sm" onClick={() => { setEditing(row); setPrice((Number(row.price || 0) / 100).toFixed(2)); setFormError(''); }}>Edit Price</button><button type="button" className="btn btn--secondary btn--sm" onClick={() => labTestStatusMutation.mutate({ test: row })} disabled={labTestStatusMutation.isPending}>{row.isActive ? 'Deactivate' : 'Activate'}</button></div> },
  ], [labTestStatusMutation]);
  const openCreate = () => { setLabTestForm({ mode: 'create', test: null }); setLabTestFormError(''); setLabTestFieldErrors({}); };
  const submitLabTest = (data) => saveMutation.mutate({ id: labTestForm?.mode === 'edit' ? labTestForm.test.id : null, data });
  const submitPrice = (event) => {
    event.preventDefault();
    const rupees = Number(price);
    if (!Number.isFinite(rupees) || rupees < 0) return setFormError('Enter a valid non-negative price.');
    priceMutation.mutate({ id: editing.id, value: Math.round(rupees * 100) });
  };
  return (
    <div>
      <PageHeader title="Lab Test Catalog" subtitle="Add lab tests and manage catalog details and prices." />
      <div className="page-header__actions" style={{ marginBottom: '1rem' }}><button type="button" className="btn btn--primary" onClick={openCreate}>Add Lab Test</button></div>
      <FilterBar>
        <FormField label="Search tests" htmlFor="catalog-search"><input id="catalog-search" className="form-control" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, code, category or sample" /></FormField>
        <FormField label="Category" htmlFor="catalog-category"><select id="catalog-category" className="form-control" value={category} onChange={(event) => setCategory(event.target.value)}><option value="">All categories</option>{categories.map((item) => <option key={item} value={item}>{item}</option>)}</select></FormField>
        <FormField label="Status" htmlFor="catalog-status"><select id="catalog-status" className="form-control" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">All tests</option><option value="true">Active</option><option value="false">Inactive</option></select></FormField>
        <button type="button" className="btn btn--ghost" onClick={() => { setSearch(''); setCategory(''); setStatusFilter(''); }}>Reset filters</button>
      </FilterBar>
      {catalogQuery.isLoading ? <LoadingState message="Loading lab catalog..." /> : catalogQuery.error ? <ErrorState title="Unable to load the lab catalog" error={catalogQuery.error} onRetry={catalogQuery.refetch} /> : rows.length === 0 ? <EmptyState title={catalogQuery.data?.length ? 'No matching tests' : 'Catalog is empty'} description={catalogQuery.data?.length ? 'Try changing or clearing the filters.' : 'No lab tests are available in the catalog.'} icon="icon-flask" /> : <section className="glass card" style={{ padding: '1rem' }}><DataTable columns={columns} data={rows} perPage={10} /></section>}
      <Modal isOpen={Boolean(editing)} onClose={() => !priceMutation.isPending && setEditing(null)} title={editing ? `Edit Price: ${editing.name}` : 'Edit Price'}>
        <form id="catalog-price-form" onSubmit={submitPrice} noValidate>
          {formError && <p role="alert" style={{ color: 'var(--danger)' }}>{formError}</p>}
          <p className="text-caption">Changing a catalog price does not alter historical lab orders.</p>
          <FormField label="Price (₹)" htmlFor="catalog-price" required><input id="catalog-price" type="number" min="0" step="0.01" className="form-control" value={price} onChange={(event) => setPrice(event.target.value)} required /></FormField>
        </form>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '1rem' }}><button type="button" className="btn btn--secondary" onClick={() => setEditing(null)} disabled={priceMutation.isPending}>Cancel</button><button type="submit" form="catalog-price-form" className="btn btn--primary" disabled={priceMutation.isPending}>{priceMutation.isPending ? 'Saving…' : 'Save Price'}</button></div>
      </Modal>
      <Modal isOpen={Boolean(labTestForm)} onClose={() => !saveMutation.isPending && setLabTestForm(null)} title={labTestForm?.mode === 'edit' ? `Edit Lab Test: ${labTestForm.test.name}` : 'Add Lab Test'} size="lg">
        <LabTestCreateForm
          key={labTestForm?.test?.id || 'new-lab-test'}
          initialValues={labTestForm?.test}
          existingTests={catalogQuery.data || []}
          mode={labTestForm?.mode}
          onSubmit={submitLabTest}
          onCancel={() => setLabTestForm(null)}
          onClearServerErrors={() => { setLabTestFormError(''); setLabTestFieldErrors({}); }}
          isPending={saveMutation.isPending}
          error={labTestFormError}
          fieldErrors={labTestFieldErrors}
        />
      </Modal>
    </div>
  );
}

export function AdminSuppliersPage() {
  const client = useQueryClient();
  const toast = useToast();
  const [supplierSearch, setSupplierSearch] = useState('');
  const [supplierFilter, setSupplierFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [selectedSupplier, setSelectedSupplier] = useState(null);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [supplierFormOpen, setSupplierFormOpen] = useState(false);
  const [supplierFormError, setSupplierFormError] = useState('');
  const [supplierForm, setSupplierForm] = useState({ name: '', contactPerson: '', phone: '', email: '', address: '', isActive: true });
  const supplierQuery = useQuery({ queryKey: ['adminSuppliers'], queryFn: () => fetchAllPages(suppliersApi.list) });
  const createSupplierMutation = useMutation({
    mutationFn: (data) => suppliersApi.create(data),
    onSuccess: async () => { toast.success('Supplier added.'); setSupplierFormOpen(false); setSupplierFormError(''); setSupplierForm({ name: '', contactPerson: '', phone: '', email: '', address: '', isActive: true }); await client.invalidateQueries({ queryKey: ['adminSuppliers'] }); },
    onError: (error) => setSupplierFormError(errorMessage(error)),
  });
  const supplierStatusMutation = useMutation({
    mutationFn: ({ supplier }) => suppliersApi.update(supplier.id, { isActive: !supplier.isActive }),
    onSuccess: async (_data, { supplier }) => { toast.success(`Supplier ${supplier.isActive ? 'deactivated' : 'activated'}.`); await client.invalidateQueries({ queryKey: ['adminSuppliers'] }); },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const orderQuery = useQuery({ queryKey: ['adminPurchaseOrders', supplierFilter, statusFilter], queryFn: () => fetchAllPages(purchaseOrdersApi.list, { ...(supplierFilter ? { supplier: supplierFilter } : {}), ...(statusFilter ? { status: statusFilter } : {}) }) });
  const orderDetailQuery = useQuery({ queryKey: ['adminPurchaseOrder', selectedOrder?.id], queryFn: () => purchaseOrdersApi.get(selectedOrder.id), enabled: Boolean(selectedOrder) });
  const suppliers = supplierQuery.data || [];
  const visibleSuppliers = suppliers.filter((supplier) => !supplierSearch.trim() || supplier.name.toLowerCase().includes(supplierSearch.trim().toLowerCase()));
  const openSupplierCreate = () => { setSupplierFormError(''); setSupplierFormOpen(true); };
  const submitSupplier = (event) => {
    event.preventDefault();
    if (!supplierForm.name.trim()) return setSupplierFormError('Enter a supplier name.');
    createSupplierMutation.mutate({ name: supplierForm.name.trim(), contactPerson: supplierForm.contactPerson.trim(), phone: supplierForm.phone.trim(), email: supplierForm.email.trim(), address: supplierForm.address.trim(), isActive: supplierForm.isActive });
  };
  const orders = orderQuery.data || [];
  const statuses = [...new Set(orders.map((order) => order.status).filter(Boolean))].sort();
  const supplierColumns = useMemo(() => [
    { key: 'name', label: 'Supplier', sortable: true, render: (row) => <strong>{row.name}</strong> },
    { key: 'contactPerson', label: 'Contact', sortable: true, render: (row) => row.contactPerson || '—' },
    { key: 'phone', label: 'Phone', render: (row) => row.phone || '—' },
    { key: 'email', label: 'Email', render: (row) => row.email || '—' },
    { key: 'isActive', label: 'Status', render: (row) => <Badge status={row.isActive ? 'ACTIVE' : 'INACTIVE'}>{row.isActive ? 'Active' : 'Inactive'}</Badge> },
    { key: 'actions', label: 'Actions', render: (row) => <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}><button type="button" className="btn btn--secondary btn--sm" onClick={() => setSelectedSupplier(row)}>Details</button><button type="button" className="btn btn--secondary btn--sm" onClick={() => supplierStatusMutation.mutate({ supplier: row })} disabled={supplierStatusMutation.isPending}>{row.isActive ? 'Deactivate' : 'Activate'}</button></div> },
  ], [supplierStatusMutation]);
  const orderColumns = useMemo(() => [
    { key: 'id', label: 'PO #', sortable: true, render: (row) => <strong>{row.id}</strong> },
    { key: 'orderDate', label: 'Order Date', sortable: true, render: (row) => formatDate(row.orderDate || row.createdAt) },
    { key: 'supplierName', label: 'Supplier', sortable: true, render: (row) => row.supplierName || row.supplierId || '—' },
    { key: 'items', label: 'Items', render: (row) => Array.isArray(row.items) ? row.items.length : 0 },
    { key: 'totalAmount', label: 'Total', sortable: true, render: (row) => formatPaise(row.totalAmount) },
    { key: 'status', label: 'Status', render: (row) => <Badge status={row.status}>{row.status || '—'}</Badge> },
    { key: 'actions', label: 'Details', render: (row) => <button type="button" className="btn btn--secondary btn--sm" onClick={() => setSelectedOrder(row)}>View</button> },
  ], []);
  return (
    <div>
      <PageHeader title="Suppliers & Purchase Orders" subtitle="Manage supplier records and review purchase-order history." />
      <section className="glass card" style={{ padding: '1rem', marginBottom: '1rem' }}>
        <h2 className="text-card-title">Supplier Directory</h2>
        <div style={{ marginBottom: '1rem' }}><button type="button" className="btn btn--primary" onClick={openSupplierCreate}>Add Supplier</button></div>
        <div style={{ display: 'flex', gap: '.75rem', marginBottom: '1rem', maxWidth: 420 }}><input aria-label="Search suppliers" className="form-control" value={supplierSearch} onChange={(event) => setSupplierSearch(event.target.value)} placeholder="Search supplier name" /><button type="button" className="btn btn--ghost" onClick={() => setSupplierSearch('')}>Clear</button></div>
        {supplierQuery.isLoading ? <LoadingState message="Loading suppliers..." /> : supplierQuery.error ? <ErrorState title="Unable to load suppliers" error={supplierQuery.error} onRetry={supplierQuery.refetch} /> : visibleSuppliers.length === 0 ? <EmptyState title={suppliers.length ? 'No suppliers match that search' : 'No suppliers found'} description={suppliers.length ? 'Try another supplier name.' : 'Add a supplier to populate the directory.'} icon="icon-package" action={!suppliers.length && <button type="button" className="btn btn--primary" onClick={openSupplierCreate}>Add Supplier</button>} /> : <DataTable columns={supplierColumns} data={visibleSuppliers} perPage={10} />}
      </section>
      <section className="glass card" style={{ padding: '1rem' }}>
        <h2 className="text-card-title">Purchase Order History</h2>
        <FilterBar>
          <FormField label="Supplier" htmlFor="po-supplier"><select id="po-supplier" className="form-control" value={supplierFilter} onChange={(event) => setSupplierFilter(event.target.value)}><option value="">All suppliers</option>{suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></FormField>
          <FormField label="Status" htmlFor="po-status"><select id="po-status" className="form-control" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">All statuses</option>{statuses.map((item) => <option key={item} value={item}>{item}</option>)}</select></FormField>
          <button type="button" className="btn btn--ghost" onClick={() => { setSupplierFilter(''); setStatusFilter(''); }}>Reset filters</button>
        </FilterBar>
        {orderQuery.isLoading ? <LoadingState message="Loading purchase orders..." /> : orderQuery.error ? <ErrorState title="Unable to load purchase orders" error={orderQuery.error} onRetry={orderQuery.refetch} /> : orders.length === 0 ? <EmptyState title="No purchase orders found" description="There are no orders matching the selected filters." icon="icon-clipboard-list" /> : <DataTable columns={orderColumns} data={orders} perPage={10} />}
      </section>
      <Modal isOpen={supplierFormOpen} onClose={() => !createSupplierMutation.isPending && setSupplierFormOpen(false)} title="Add Supplier" size="lg">
        <form id="supplier-create-form" onSubmit={submitSupplier} noValidate>
          {supplierFormError && <p role="alert" style={{ color: 'var(--danger)' }}>{supplierFormError}</p>}
          <div className="form-grid">
            <FormField label="Supplier name" htmlFor="supplier-name" required><input id="supplier-name" className="form-control" maxLength={100} value={supplierForm.name} onChange={(event) => setSupplierForm({ ...supplierForm, name: event.target.value })} required /></FormField>
            <FormField label="Contact person" htmlFor="supplier-contact"><input id="supplier-contact" className="form-control" maxLength={100} value={supplierForm.contactPerson} onChange={(event) => setSupplierForm({ ...supplierForm, contactPerson: event.target.value })} /></FormField>
            <FormField label="Phone" htmlFor="supplier-phone"><input id="supplier-phone" className="form-control" maxLength={20} value={supplierForm.phone} onChange={(event) => setSupplierForm({ ...supplierForm, phone: event.target.value })} /></FormField>
            <FormField label="Email" htmlFor="supplier-email"><input id="supplier-email" type="email" className="form-control" maxLength={100} value={supplierForm.email} onChange={(event) => setSupplierForm({ ...supplierForm, email: event.target.value })} /></FormField>
            <FormField label="Address" htmlFor="supplier-address"><textarea id="supplier-address" className="form-control" value={supplierForm.address} onChange={(event) => setSupplierForm({ ...supplierForm, address: event.target.value })} /></FormField>
            <label className="form-check"><input type="checkbox" checked={supplierForm.isActive} onChange={(event) => setSupplierForm({ ...supplierForm, isActive: event.target.checked })} /> Active</label>
          </div>
        </form>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '1rem' }}><button type="button" className="btn btn--secondary" onClick={() => setSupplierFormOpen(false)} disabled={createSupplierMutation.isPending}>Cancel</button><button type="submit" form="supplier-create-form" className="btn btn--primary" disabled={createSupplierMutation.isPending}>{createSupplierMutation.isPending ? 'Saving...' : 'Add Supplier'}</button></div>
      </Modal>
      <Modal isOpen={Boolean(selectedSupplier)} onClose={() => setSelectedSupplier(null)} title={selectedSupplier?.name || 'Supplier details'}>
        <div className="form-grid"><div><strong>Contact</strong><div>{selectedSupplier?.contactPerson || '—'}</div></div><div><strong>Phone</strong><div>{selectedSupplier?.phone || '—'}</div></div><div><strong>Email</strong><div>{selectedSupplier?.email || '—'}</div></div><div><strong>Address</strong><div>{selectedSupplier?.address || '—'}</div></div><div><strong>Status</strong><div>{selectedSupplier?.isActive ? 'Active' : 'Inactive'}</div></div></div>
      </Modal>
      <Modal isOpen={Boolean(selectedOrder)} onClose={() => setSelectedOrder(null)} title={orderDetailQuery.data ? `Purchase Order ${orderDetailQuery.data.id}` : 'Purchase Order details'} size="lg">
        {orderDetailQuery.isLoading ? <LoadingState message="Loading purchase order..." /> : orderDetailQuery.error ? <ErrorState title="Unable to load purchase order" error={orderDetailQuery.error} onRetry={orderDetailQuery.refetch} /> : orderDetailQuery.data && <div>
          <p><strong>Supplier:</strong> {orderDetailQuery.data.supplierName || orderDetailQuery.data.supplierId || '—'} &nbsp; <strong>Status:</strong> {orderDetailQuery.data.status || '—'}</p>
          <p><strong>Order:</strong> {formatDate(orderDetailQuery.data.orderDate)} &nbsp; <strong>Expected:</strong> {formatDate(orderDetailQuery.data.expectedDate)} &nbsp; <strong>Received:</strong> {formatDate(orderDetailQuery.data.receivedDate)}</p>
          <p><strong>Total:</strong> {formatPaise(orderDetailQuery.data.totalAmount)}</p>
          <DataTable columns={[
            { key: 'medicineId', label: 'Medicine reference', render: (row) => row.medicineId || '—' },
            { key: 'quantityOrdered', label: 'Ordered', render: (row) => row.quantityOrdered ?? row.quantity ?? '—' },
            { key: 'quantityReceived', label: 'Received', render: (row) => row.quantityReceived ?? '—' },
            { key: 'unitCost', label: 'Unit Cost', render: (row) => row.unitCost == null ? '—' : formatPaise(row.unitCost) },
          ]} data={Array.isArray(orderDetailQuery.data.items) ? orderDetailQuery.data.items : []} perPage={10} emptyTitle="No item details" />
          {orderDetailQuery.data.notes && <p><strong>Notes:</strong> {orderDetailQuery.data.notes}</p>}
        </div>}
      </Modal>
    </div>
  );
}

const REPORTS = [
  { id: 'appointments', label: 'Appointments' },
  { id: 'revenue', label: 'Revenue by bill' },
  { id: 'medicines', label: 'Current medicine stock snapshot' },
];

function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function downloadCsv(rows, filename) {
  if (!rows.length) return;
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const csv = [headers.map(csvCell).join(','), ...rows.map((row) => headers.map((key) => csvCell(row[key])).join(','))].join('\r\n');
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function AdminReportsPage() {
  const [type, setType] = useState('appointments');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [queryParams, setQueryParams] = useState(null);
  const [validationError, setValidationError] = useState('');
  const reportQuery = useQuery({ queryKey: ['adminReport', queryParams], queryFn: () => reportsApi.generate(queryParams), enabled: Boolean(queryParams) });
  const report = reportQuery.data;
  const columns = useMemo(() => {
    const keys = [...new Set((report?.data || []).flatMap((row) => Object.keys(row)))];
    return keys.map((key) => ({ key, label: key.replace(/([A-Z])/g, ' $1').replace(/^./, (letter) => letter.toUpperCase()), sortable: true, render: (row) => {
      const value = row[key];
      if (value == null || value === '') return '—';
      if (/date/i.test(key)) return formatDate(value);
      if (/Paise$/.test(key)) return formatPaise(value);
      return String(value);
    } }));
  }, [report]);
  const submit = (event) => {
    event.preventDefault();
    setValidationError('');
    if (type !== 'medicines' && start && end && start > end) return setValidationError('Start date must be on or before end date.');
    const params = { type };
    if (type !== 'medicines') {
      if (start) params.start = start;
      if (end) params.end = end;
    }
    setQueryParams(params);
  };
  const exportReport = () => {
    if (!report?.data?.length) return;
    const suffix = queryParams?.start && queryParams?.end ? `_${queryParams.start}_to_${queryParams.end}` : '';
    downloadCsv(report.data, `${report.type}_report${suffix}.csv`);
  };
  return (
    <div>
      <PageHeader title="Reports" subtitle="Generate reports supported by the current API and export returned rows to CSV." />
      <section className="glass card" style={{ padding: '1.25rem', maxWidth: 760, marginBottom: '1rem' }}>
        <form id="admin-report-form" onSubmit={submit} noValidate>
          {validationError && <p role="alert" style={{ color: 'var(--danger)' }}>{validationError}</p>}
          <div className="form-grid">
            <FormField label="Report type" htmlFor="report-type" required><select id="report-type" className="form-control" value={type} onChange={(event) => setType(event.target.value)}>{REPORTS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}<option disabled>Outstanding balances — unavailable</option><option disabled>Lab volume — unavailable</option></select></FormField>
            <FormField label="Start date" htmlFor="report-start"><input id="report-start" type="date" className="form-control" value={start} onChange={(event) => setStart(event.target.value)} disabled={type === 'medicines'} /></FormField>
            <FormField label="End date" htmlFor="report-end"><input id="report-end" type="date" className="form-control" value={end} onChange={(event) => setEnd(event.target.value)} disabled={type === 'medicines'} /></FormField>
          </div>
          <p className="text-caption">Appointment and revenue reports accept date filters. Medicine data is a current stock snapshot and is not date-filtered by the API.</p>
          <button type="submit" className="btn btn--primary" disabled={reportQuery.isFetching}>{reportQuery.isFetching ? 'Generating…' : 'Generate Report'}</button>
        </form>
      </section>
      {reportQuery.isLoading ? <LoadingState message="Generating report..." /> : reportQuery.error ? <ErrorState title="Unable to generate report" error={reportQuery.error} onRetry={reportQuery.refetch} /> : report && report.data.length === 0 ? <EmptyState title="No report rows" description="The selected report returned no records." icon="icon-bar-chart" /> : report && <section className="glass card" style={{ padding: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}><div><h2 className="text-card-title" style={{ margin: 0 }}>{REPORTS.find((item) => item.id === report.type)?.label || report.type}</h2><p className="text-caption">{report.count} returned row(s). The API caps each report at 100 rows.</p></div><button type="button" className="btn btn--secondary" onClick={exportReport}>Export CSV</button></div>
        <DataTable columns={columns} data={report.data} perPage={10} />
      </section>}
    </div>
  );
}

const SETTING_FIELDS = [
  { key: 'clinic.name', label: 'Clinic name', type: 'text' },
  { key: 'clinic.phone', label: 'Phone', type: 'tel' },
  { key: 'clinic.email', label: 'Email', type: 'email' },
  { key: 'clinic.address', label: 'Address', type: 'textarea' },
  { key: 'appointment.slotDuration', label: 'Appointment slot duration (minutes)', type: 'number', min: 5, max: 240 },
  { key: 'appointment.startTime', label: 'Working start time', type: 'time' },
  { key: 'appointment.endTime', label: 'Working end time', type: 'time' },
  { key: 'billing.registrationFee', label: 'Registration fee (₹)', type: 'money', min: 0 },
];

function decodeSetting(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function settingsToForm(settings = {}) {
  return Object.fromEntries(SETTING_FIELDS.map(({ key, type }) => {
    const decoded = decodeSetting(settings[key]);
    const value = decoded == null ? '' : String(decoded);
    return [key, type === 'money' && value !== '' ? (Number(value) / 100).toFixed(2) : value];
  }));
}

export function AdminSettingsPage() {
  const client = useQueryClient();
  const toast = useToast();
  const [overrides, setOverrides] = useState({});
  const [formError, setFormError] = useState('');
  const settingsQuery = useQuery({ queryKey: ['adminSettings'], queryFn: settingsApi.list });
  const original = useMemo(() => settingsQuery.data ? settingsToForm(settingsQuery.data) : null, [settingsQuery.data]);
  const draft = original ? { ...original, ...overrides } : null;
  const saveMutation = useMutation({
    mutationFn: (data) => settingsApi.update(data),
    onSuccess: async () => { toast.success('Settings saved.'); setFormError(''); setOverrides({}); await client.invalidateQueries({ queryKey: ['adminSettings'] }); },
    onError: (error) => setFormError(errorMessage(error)),
  });
  const dirty = Boolean(draft && original && SETTING_FIELDS.some(({ key }) => draft[key] !== original[key]));
  const setValue = (key, value) => setOverrides((state) => ({ ...state, [key]: value }));
  const save = (event) => {
    event.preventDefault();
    if (!draft || !original) return;
    const changed = SETTING_FIELDS.filter(({ key }) => draft[key] !== original[key]);
    if (!changed.length) return;
    const data = {};
    for (const field of changed) {
      const value = draft[field.key].trim();
      if (!value) continue;
      if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return setFormError('Enter a valid clinic email address.');
      if (field.type === 'number' || field.type === 'money') {
        const number = Number(value);
        if (!Number.isFinite(number) || number < field.min || (field.max != null && number > field.max)) return setFormError(`${field.label} is outside the allowed range.`);
        data[field.key] = field.type === 'money' ? Math.round(number * 100) : Math.round(number);
      } else {
        data[field.key] = value;
      }
    }
    if (!Object.keys(data).length) return setFormError('Empty values are not saved; the current server values were preserved.');
    if (draft['appointment.startTime'] && draft['appointment.endTime'] && draft['appointment.startTime'] >= draft['appointment.endTime']) return setFormError('Working start time must be earlier than working end time.');
    setFormError('');
    saveMutation.mutate(data);
  };
  return (
    <div>
      <PageHeader title="Clinic Settings" subtitle="Edit settings keys currently present in the backend. Unlisted keys are left untouched." />
      {settingsQuery.isLoading ? <LoadingState message="Loading settings..." /> : settingsQuery.error ? <ErrorState title="Unable to load settings" error={settingsQuery.error} onRetry={settingsQuery.refetch} /> : <section className="glass card" style={{ padding: '1.25rem', maxWidth: 900 }}>
        <form id="admin-settings-form" onSubmit={save} noValidate>
          {formError && <p role="alert" style={{ color: 'var(--danger)' }}>{formError}</p>}
          {draft && <div className="form-grid">{SETTING_FIELDS.map((field) => <FormField key={field.key} label={field.label} htmlFor={`setting-${field.key}`} hint={settingsQuery.data[field.key] == null ? 'Not currently configured; a value will be added when saved.' : undefined}>
            {field.type === 'textarea' ? <textarea id={`setting-${field.key}`} className="form-control" rows={3} value={draft[field.key]} onChange={(event) => setValue(field.key, event.target.value)} /> : <input id={`setting-${field.key}`} type={field.type === 'money' ? 'number' : field.type} min={field.min} max={field.max} step={field.type === 'money' ? '0.01' : field.type === 'number' ? '1' : undefined} className="form-control" value={draft[field.key]} onChange={(event) => setValue(field.key, event.target.value)} />}
          </FormField>)}</div>}
          <p className="text-caption">Registration fees are stored in paise. Empty changed fields are omitted so they cannot erase a server value.</p>
          <button type="submit" className="btn btn--primary" disabled={!dirty || saveMutation.isPending}>{saveMutation.isPending ? 'Saving…' : dirty ? 'Save Changes' : 'No Unsaved Changes'}</button>
        </form>
      </section>}
    </div>
  );
}

export function AdminAuditLogPage() {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [resourceFilter, setResourceFilter] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);
  const params = { page, page_size: 20, ...(debouncedSearch ? { search: debouncedSearch } : {}), ...(actionFilter.trim() ? { action: actionFilter.trim() } : {}), ...(resourceFilter.trim() ? { resource_type: resourceFilter.trim() } : {}) };
  const auditQuery = useQuery({ queryKey: ['adminAuditLog', params], queryFn: () => auditLogApi.list(params) });
  const rows = auditQuery.data?.results || [];
  const pageCount = Math.max(1, Math.ceil((auditQuery.data?.count || 0) / 20));
  const columns = useMemo(() => [
    { key: 'createdAt', label: 'Timestamp', sortable: true, render: (row) => formatDateTime(row.createdAt) },
    { key: 'userName', label: 'Actor', sortable: true, render: (row) => row.userName || 'System' },
    { key: 'action', label: 'Action', sortable: true, render: (row) => <strong>{row.action}</strong> },
    { key: 'resourceType', label: 'Resource', sortable: true, render: (row) => `${row.resourceType || '—'}${row.resourceId ? ` · ${row.resourceId}` : ''}` },
    { key: 'details', label: 'Metadata', render: (row) => {
      const keys = row.details && typeof row.details === 'object' ? Object.keys(row.details).filter((key) => !/(password|secret|token|patient|diagnos|allerg|medical)/i.test(key)) : [];
      return keys.length ? `${keys.length} non-sensitive field(s)` : 'No displayable metadata';
    } },
  ], []);
  return (
    <div>
      <PageHeader title="System Audit Log" subtitle="Read-only activity history. Search covers action, actor username and affected resource identifiers; metadata values are not displayed." />
      <FilterBar>
        <FormField label="Search history" htmlFor="audit-search"><input id="audit-search" className="form-control" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Action, actor or resource ID" maxLength={100} /></FormField>
        <FormField label="Exact action type" htmlFor="audit-action"><input id="audit-action" className="form-control" value={actionFilter} onChange={(event) => { setActionFilter(event.target.value); setPage(1); }} maxLength={50} placeholder="e.g. RESET_PASSWORD" /></FormField>
        <FormField label="Exact resource type" htmlFor="audit-resource"><input id="audit-resource" className="form-control" value={resourceFilter} onChange={(event) => { setResourceFilter(event.target.value); setPage(1); }} maxLength={50} placeholder="e.g. USER" /></FormField>
        <button type="button" className="btn btn--ghost" onClick={() => { setSearch(''); setActionFilter(''); setResourceFilter(''); setPage(1); }}>Reset filters</button>
      </FilterBar>
      {auditQuery.isLoading ? <LoadingState message="Loading audit records..." /> : auditQuery.error ? <ErrorState title="Unable to load audit history" error={auditQuery.error} onRetry={auditQuery.refetch} /> : !rows.length ? <EmptyState title="No audit records found" description="No records match the selected filters." icon="icon-history" /> : <section className="glass card" style={{ padding: '1rem' }}>
        <DataTable columns={columns} data={rows} perPage={20} />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '.75rem', marginTop: '1rem', flexWrap: 'wrap' }}><span>{auditQuery.data.count} record(s) · Page {page} of {pageCount}</span><div style={{ display: 'flex', gap: '.5rem' }}><button type="button" className="btn btn--secondary btn--sm" disabled={!auditQuery.data.previous || auditQuery.isFetching} onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</button><button type="button" className="btn btn--secondary btn--sm" disabled={!auditQuery.data.next || auditQuery.isFetching} onClick={() => setPage((current) => current + 1)}>Next</button></div></div>
      </section>}
    </div>
  );
}
