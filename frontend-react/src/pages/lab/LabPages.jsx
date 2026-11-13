import React, { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import {
  billsApi,
  labCatalogApi,
  labOrdersApi,
  labResultsApi,
} from '../../api/resources';
import Badge from '../../components/Badge';
import Icon from '../../components/Icon';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { ConfirmDialog, FormField, Modal, openPrintView, useToast } from '../../components/ui';
import { formatDate, formatDateTime, Format } from '../../utils/format';

const PAGE_SIZE = 200;
const DISPLAY_PAGE_SIZE = 10;
const PANEL_STYLE = { padding: '1.25rem', borderRadius: '12px', marginBottom: '1rem' };
const FIELD_STYLE = { width: '100%', minWidth: 0 };
const LAB_STATUSES = [
  ['ALL', 'All statuses'],
  ['ORDERED', 'Ordered'],
  ['SAMPLE_COLLECTED', 'Sample collected'],
  ['PROCESSING', 'Processing'],
  ['COMPLETED', 'Completed'],
];

async function fetchAllPages(list, params = {}) {
  const first = await list({ ...params, page: 1, page_size: PAGE_SIZE });
  if (Array.isArray(first)) return first;
  const rows = Array.isArray(first?.results) ? [...first.results] : [];
  const pageCount = Math.ceil((first?.count || rows.length) / PAGE_SIZE);
  for (let page = 2; page <= pageCount; page += 1) {
    const next = await list({ ...params, page, page_size: PAGE_SIZE });
    rows.push(...(Array.isArray(next?.results) ? next.results : []));
  }
  return rows;
}

function useLabOrders() {
  return useQuery({
    queryKey: ['labOrders', 'all'],
    queryFn: () => fetchAllPages(labOrdersApi.list),
    refetchInterval: 15000,
  });
}

function useLabResults() {
  return useQuery({
    queryKey: ['labResults', 'all'],
    queryFn: () => fetchAllPages(labResultsApi.list),
  });
}

function useLabCatalog() {
  return useQuery({
    queryKey: ['labCatalog', 'all'],
    queryFn: () => fetchAllPages(labCatalogApi.list),
  });
}

function LabPageHeading({ title, actions }) {
  return (
    <div className="page-header" style={{ background: 'transparent', border: 'none', padding: 0 }}>
      <div className="page-header__info">
        <h1 className="text-page-title">{title}</h1>
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </div>
  );
}

function SearchAndStatus({ search, setSearch, status, setStatus, children }) {
  return (
    <div className="glass card lab-filter-panel" style={PANEL_STYLE}>
      <label className="lab-filter-panel__search">
        <Icon name="icon-search" size={16} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
        <input
          className="form-input"
          style={{ ...FIELD_STYLE, paddingLeft: '2.25rem' }}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search patient, patient ID, order ID, or test..."
          aria-label="Search laboratory records"
        />
      </label>
      {setStatus && (
        <label className="lab-filter-panel__field">
          <span>Status</span>
          <select className="form-input" value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Filter by status">
          {LAB_STATUSES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      )}
      {children}
    </div>
  );
}

function TableFrame({ headers, children, minWidth = 880 }) {
  return (
    <div className="table-wrapper lab-table-scroll">
      <table className="table lab-record-table" style={{ width: '100%', minWidth, borderCollapse: 'collapse' }}>
        <thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function usePaginatedRows(rows) {
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(rows.length / DISPLAY_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const startIndex = (currentPage - 1) * DISPLAY_PAGE_SIZE;

  return {
    pageRows: rows.slice(startIndex, startIndex + DISPLAY_PAGE_SIZE),
    page: currentPage,
    pageCount,
    setPage,
    totalRows: rows.length,
  };
}

function Pagination({ page, pageCount, setPage, totalRows }) {
  if (totalRows <= DISPLAY_PAGE_SIZE) return null;

  const firstRow = (page - 1) * DISPLAY_PAGE_SIZE + 1;
  const lastRow = Math.min(page * DISPLAY_PAGE_SIZE, totalRows);

  return (
    <div className="lab-pagination">
      <span style={{ color: 'var(--muted)', fontSize: '0.8125rem' }}>
        Showing {firstRow}–{lastRow} of {totalRows}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          onClick={() => setPage(page - 1)}
          disabled={page === 1}
        >
          Previous
        </button>
        <span aria-live="polite" style={{ color: 'var(--muted)', fontSize: '0.8125rem' }}>
          Page {page} of {pageCount}
        </span>
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          onClick={() => setPage(page + 1)}
          disabled={page === pageCount}
        >
          Next
        </button>
      </div>
    </div>
  );
}

function recordMatches(order, search) {
  const value = search.trim().toLowerCase();
  if (!value) return true;
  return [order.id, order.patientName, order.patientId, order.patientMrn, order.testName, order.testCode]
    .some((item) => String(item || '').toLowerCase().includes(value));
}

function visibleByStatus(order, filter) {
  if (filter === 'ALL') return true;
  if (filter === 'PROCESSING') return ['PROCESSING', 'IN_PROGRESS'].includes(order.status);
  return order.status === filter;
}

const priorityScore = (priority) => ({ STAT: 3, URGENT: 2, ROUTINE: 1, NORMAL: 1 }[String(priority || '').toUpperCase()] || 0);

function turnaroundHours(order) {
  const startedAt = order.createdAt || order.sampleCollectedAt;
  if (!startedAt || !order.completedAt) return null;
  const elapsed = new Date(order.completedAt).getTime() - new Date(startedAt).getTime();
  return Number.isFinite(elapsed) && elapsed >= 0 ? Number((elapsed / 3600000).toFixed(1)) : null;
}

function formatReferenceRange(parameter, includeUnit = true) {
  if (!parameter) return 'Not specified';
  if (parameter.referenceText) {
    return includeUnit && parameter.unit ? `${parameter.referenceText} ${parameter.unit}` : parameter.referenceText;
  }
  const min = parameter.refMin ?? parameter.min;
  const max = parameter.refMax ?? parameter.max;
  let range = 'Not specified';
  if (min != null && max != null) range = `${min} - ${max}`;
  else if (min != null) range = `≥${min}`;
  else if (max != null) range = `≤${max}`;
  return includeUnit && parameter.unit ? `${range} ${parameter.unit}` : range;
}

function isNumericParameter(parameter) {
  const type = String(parameter.dataType || parameter.type || '').toLowerCase();
  if (['number', 'numeric', 'integer', 'decimal'].includes(type)) return true;
  if (['text', 'string', 'qualitative', 'boolean', 'choice'].includes(type)) return false;
  return Boolean(
    parameter.unit
    || parameter.refMin != null
    || parameter.refMax != null
    || parameter.min != null
    || parameter.max != null
    || parameter.criticalMin != null
    || parameter.criticalMax != null
    || parameter.criticalLow != null
    || parameter.criticalHigh != null
  );
}

function resultValues(results) {
  if (Array.isArray(results)) {
    return Object.fromEntries(results.filter((item) => item?.parameter).map((item) => [item.parameter, item.value ?? '']));
  }
  return results && typeof results === 'object' ? results : {};
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function printLabReport(order, result, catalog) {
  const resultRows = Array.isArray(result.results)
    ? result.results
    : Object.entries(result.results || {}).map(([parameter, value]) => ({ parameter, value }));
  const rowsHtml = resultRows.map((row) => {
    const definition = (catalog?.parameters || []).find((parameter) => parameter.name === row.parameter);
    const value = row && typeof row === 'object' ? row.value : row;
    const unit = (row && typeof row === 'object' ? row.unit : '') || definition?.unit || '';
    const reference = formatReferenceRange(definition);
    const flag = row?.flag ? escapeHtml(String(row.flag).replace(/_/g, ' ')) : 'Not flagged';
    return `<tr><td>${escapeHtml(row?.parameter || 'Result')}</td><td>${escapeHtml(value)} ${escapeHtml(unit)}</td><td>${escapeHtml(reference)}</td><td>${flag}</td></tr>`;
  }).join('');
  openPrintView(`Laboratory report ${order.id}`, `
    <h1>Laboratory Report</h1>
    <p><strong>Order:</strong> ${escapeHtml(order.id)} · <strong>Test:</strong> ${escapeHtml(order.testName)}</p>
    <p><strong>Patient:</strong> ${escapeHtml(order.patientName)} · <strong>MRN:</strong> ${escapeHtml(order.patientMrn || order.patientId)}</p>
    <p><strong>Referred by:</strong> ${escapeHtml(order.doctorName || '—')} · <strong>Technician:</strong> ${escapeHtml(result.performedByName || '—')}</p>
    <p><strong>Sample collected:</strong> ${escapeHtml(formatDateTime(order.sampleCollectedAt))} · <strong>Reported:</strong> ${escapeHtml(formatDateTime(order.completedAt || result.resultDate))}</p>
    <table><thead><tr><th>Investigation</th><th>Result</th><th>Catalog reference range</th><th>Recorded flag</th></tr></thead><tbody>${rowsHtml}</tbody></table>
    ${result.remarks ? `<p><strong>Technician remarks:</strong> ${escapeHtml(result.remarks)}</p>` : ''}
    <p><em>This report reflects recorded laboratory results. The system has no separate verification status.</em></p>
  `);
}

function ResultEntryDialog({ order, catalog, existingResult, onClose }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const parameters = Array.isArray(catalog?.parameters) ? catalog.parameters : [];
  const [values, setValues] = useState(() => resultValues(existingResult?.results || order.results));
  const [remarks, setRemarks] = useState(existingResult?.remarks || '');
  const [formError, setFormError] = useState('');
  const [confirmSave, setConfirmSave] = useState(false);
  const abnormalParameters = parameters.filter((parameter) => {
    if (!isNumericParameter(parameter) || !String(values[parameter.name] ?? '').trim()) return false;
    const value = Number(values[parameter.name]);
    if (!Number.isFinite(value)) return false;
    const min = parameter.refMin ?? parameter.min;
    const max = parameter.refMax ?? parameter.max;
    return (min != null && value < Number(min)) || (max != null && value > Number(max));
  });
  const criticalParameters = parameters.filter((parameter) => {
    if (!isNumericParameter(parameter) || !String(values[parameter.name] ?? '').trim()) return false;
    const value = Number(values[parameter.name]);
    if (!Number.isFinite(value)) return false;
    const criticalMin = parameter.criticalMin ?? parameter.criticalLow;
    const criticalMax = parameter.criticalMax ?? parameter.criticalHigh;
    return (criticalMin != null && value <= Number(criticalMin))
      || (criticalMax != null && value >= Number(criticalMax));
  });

  const saveMutation = useMutation({
    mutationFn: (payload) => labOrdersApi.enterResult(order.id, payload),
    onSuccess: (savedOrder) => {
      if (savedOrder.isCritical && savedOrder.notificationSent) {
        toast.success(`Critical result sent to Dr. ${savedOrder.notificationRecipient}.`);
      } else if (savedOrder.isCritical) {
        toast.error('Critical result saved, but no user account is linked to the prescribing doctor. Contact an administrator.');
      } else {
        toast.success('Test result saved. The order is now completed.');
      }
      setConfirmSave(false);
      queryClient.invalidateQueries({ queryKey: ['labOrders'] });
      queryClient.invalidateQueries({ queryKey: ['labResults'] });
      queryClient.invalidateQueries({ queryKey: ['labDashboard'] });
      onClose();
    },
    onError: (error) => {
      setConfirmSave(false);
      setFormError(error?.response?.data?.detail || 'Could not save the result. Please try again.');
    },
  });

  const submit = (event) => {
    event.preventDefault();
    setFormError('');
    const required = parameters.filter((parameter) => parameter.required !== false);
    if (required.some((parameter) => !String(values[parameter.name] ?? '').trim())) {
      setFormError('Enter a value for each required test parameter.');
      return;
    }
    const invalidNumeric = parameters.find((parameter) => {
      const type = String(parameter.dataType || parameter.type || '').toLowerCase();
      if (!isNumericParameter(parameter) || !String(values[parameter.name] ?? '').trim()) return false;
      const value = Number(values[parameter.name]);
      return !Number.isFinite(value) || (type === 'integer' && !Number.isInteger(value));
    });
    if (invalidNumeric) {
      setFormError(`${invalidNumeric.name} must be a valid ${invalidNumeric.dataType || invalidNumeric.type} value.`);
      return;
    }
    if (!parameters.length && !String(values.Result ?? '').trim()) {
      setFormError('Enter the test result before saving.');
      return;
    }
    setConfirmSave(true);
  };

  return (
    <Modal isOpen onClose={onClose} title={`${existingResult ? 'Edit' : 'Enter'} Result · ${order.id}`} size="lg">
      <form onSubmit={submit}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem', marginBottom: '1rem' }}>
          <div><small>Patient</small><div><strong>{order.patientName}</strong> · {order.patientMrn || order.patientId}</div></div>
          <div><small>Test</small><div><strong>{order.testName}</strong> · {order.testCode || '—'}</div></div>
        </div>
        {parameters.length ? (
          <section aria-label="Test parameters" style={{ display: 'grid', gap: '0.75rem', marginBottom: '1rem' }}>
            <div>
              <h3 style={{ margin: '0 0 0.25rem', fontSize: '1rem' }}>Results & reference ranges</h3>
              <small style={{ color: 'var(--muted)' }}>Enter each result using the units shown. Out-of-range values are flagged, not blocked.</small>
            </div>
            {parameters.map((parameter) => {
              const rawValue = String(values[parameter.name] ?? '');
              const hasValue = Boolean(rawValue.trim());
              const numeric = isNumericParameter(parameter);
              const dataType = String(parameter.dataType || parameter.type || '').toLowerCase();
              const numericValue = Number(rawValue);
              const invalid = hasValue && numeric
                && (!Number.isFinite(numericValue) || (dataType === 'integer' && !Number.isInteger(numericValue)));
              const min = parameter.refMin ?? parameter.min;
              const max = parameter.refMax ?? parameter.max;
              const belowRange = hasValue && numeric && Number.isFinite(numericValue) && min != null && numericValue < Number(min);
              const aboveRange = hasValue && numeric && Number.isFinite(numericValue) && max != null && numericValue > Number(max);
              const criticalMin = parameter.criticalMin ?? parameter.criticalLow;
              const criticalMax = parameter.criticalMax ?? parameter.criticalHigh;
              const isCritical = hasValue && numeric && Number.isFinite(numericValue)
                && ((criticalMin != null && numericValue <= Number(criticalMin))
                  || (criticalMax != null && numericValue >= Number(criticalMax)));
              const inputId = `result-${parameter.name}`;
              const feedbackId = `${inputId}-feedback`;

              return (
                <div key={parameter.name} className="glass card" style={{ padding: '1rem', borderRadius: '10px', border: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
                    <div>
                      <label className="form-group__label" htmlFor={inputId} style={{ marginBottom: '0.2rem' }}>
                        {parameter.name}{parameter.required !== false ? ' *' : ''}
                      </label>
                      {parameter.unit && <small style={{ color: 'var(--muted)' }}>Unit: {parameter.unit}</small>}
                    </div>
                    {hasValue && !invalid && (
                      <Badge variant={isCritical ? 'danger' : belowRange || aboveRange ? 'warning' : 'success'}>
                        {isCritical ? 'Critical threshold' : belowRange ? 'Below range' : aboveRange ? 'Above range' : min != null || max != null ? 'Within range' : 'Recorded'}
                      </Badge>
                    )}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '0.75rem', alignItems: 'end' }}>
                    <div style={{ padding: '0.7rem 0.8rem', background: 'var(--surface, rgba(255,255,255,0.55))', borderRadius: '8px', minHeight: '64px' }}>
                      <small style={{ display: 'block', color: 'var(--muted)', marginBottom: '0.25rem' }}>Reference range</small>
                      <strong>{formatReferenceRange(parameter)}</strong>
                      {(criticalMin != null || criticalMax != null) && (
                        <small style={{ display: 'block', color: 'var(--muted)', marginTop: '0.2rem' }}>
                          Critical at {criticalMin != null ? `≤${criticalMin}` : ''}{criticalMin != null && criticalMax != null ? ' or ' : ''}{criticalMax != null ? `≥${criticalMax}` : ''}
                        </small>
                      )}
                    </div>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label className="form-group__label" htmlFor={inputId}>Result{parameter.required !== false ? ' *' : ''}</label>
                      <input
                        className="form-input"
                        type={numeric ? 'number' : 'text'}
                        step={dataType === 'integer' ? '1' : 'any'}
                        id={inputId}
                        value={values[parameter.name] ?? ''}
                        onChange={(event) => setValues((current) => ({ ...current, [parameter.name]: event.target.value }))}
                        required={parameter.required !== false}
                        aria-invalid={invalid}
                        aria-describedby={feedbackId}
                      />
                    </div>
                  </div>
                  <small id={feedbackId} role={invalid || isCritical || belowRange || aboveRange ? 'status' : undefined} style={{ display: 'block', marginTop: '0.5rem', color: invalid || isCritical ? 'var(--danger)' : belowRange || aboveRange ? 'var(--warning)' : 'var(--muted)' }}>
                    {invalid
                      ? `Enter a valid ${parameter.dataType || parameter.type || 'numeric'} value.`
                      : isCritical
                        ? 'This value meets a critical threshold and will be flagged.'
                        : belowRange || aboveRange
                          ? 'Outside the reference range; this value can still be recorded and will be flagged.'
                          : min != null || max != null
                            ? 'Compare the result with the catalog reference range above.'
                            : 'No reference range configured for this parameter.'}
                  </small>
                </div>
              );
            })}
          </section>
        ) : (
          <div style={{ marginBottom: '1rem' }}>
            <div className="form-group">
              <label className="form-group__label" htmlFor="result-value">Result *</label>
              <textarea className="form-input" id="result-value" rows="4" value={values.Result ?? ''} onChange={(event) => setValues((current) => ({ ...current, Result: event.target.value }))} required aria-describedby="result-config-help" />
            </div>
            <small id="result-config-help" style={{ color: 'var(--muted)' }}>No parameter-specific reference ranges are configured for this test. Enter the result with its units and interpretation.</small>
          </div>
        )}
        <div className="form-group" style={{ marginBottom: '1rem' }}>
          <label className="form-group__label" htmlFor="result-remarks">Technician remarks</label>
          <textarea className="form-input" id="result-remarks" rows="3" value={remarks} onChange={(event) => setRemarks(event.target.value)} />
        </div>
        {formError && <p role="alert" style={{ color: 'var(--danger)', marginBottom: '1rem' }}>{formError}</p>}
        {abnormalParameters.length > 0 && (
          <p role="status" style={{ color: criticalParameters.length ? 'var(--danger)' : 'var(--warning)', marginBottom: '1rem' }}>
            {criticalParameters.length
              ? `Critical threshold reached for ${criticalParameters.map((parameter) => parameter.name).join(', ')}. Review before saving.`
              : `Outside the catalog reference range: ${abnormalParameters.map((parameter) => parameter.name).join(', ')}. Values can still be recorded and will be flagged.`}
          </p>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
          <button type="button" className="btn btn--secondary" onClick={onClose} disabled={saveMutation.isPending}>Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={saveMutation.isPending}>
            {saveMutation.isPending ? 'Saving…' : 'Save and complete test'}
          </button>
        </div>
      </form>
      <ConfirmDialog
        isOpen={confirmSave}
        onClose={() => setConfirmSave(false)}
        onConfirm={() => saveMutation.mutate({ results: values, remarks: remarks.trim() })}
        title={existingResult ? 'Confirm result update' : 'Confirm test result'}
        message={abnormalParameters.length || criticalParameters.length
          ? `Save these results and complete this order? ${abnormalParameters.length} value(s) are outside the configured reference range${criticalParameters.length ? `; ${criticalParameters.length} meet a critical threshold` : ''}.`
          : 'Save these values to the laboratory record and complete this order?'}
        confirmLabel={existingResult ? 'Save update' : 'Save and complete'}
        isLoading={saveMutation.isPending}
      />
    </Modal>
  );
}

function useOrderStatusMutation() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id, status }) => labOrdersApi.updateStatus(id, status),
    onSuccess: (_data, variables) => {
      toast.success(variables.status === 'SAMPLE_COLLECTED' ? 'Specimen collection recorded.' : 'Order status updated.');
      queryClient.invalidateQueries({ queryKey: ['labOrders'] });
      queryClient.invalidateQueries({ queryKey: ['labDashboard'] });
    },
    onError: (error) => toast.error(error?.response?.data?.detail || 'Could not update this order.'),
  });
}

function OrderAction({ order, onEnterResult, statusMutation }) {
  if (order.status === 'ORDERED') {
    return <button type="button" className="btn btn--secondary btn--sm" disabled={statusMutation.isPending} onClick={() => statusMutation.mutate({ id: order.id, status: 'SAMPLE_COLLECTED' })}>Collect sample</button>;
  }
  if (order.status === 'SAMPLE_COLLECTED') {
    return <button type="button" className="btn btn--secondary btn--sm" disabled={statusMutation.isPending} onClick={() => statusMutation.mutate({ id: order.id, status: 'PROCESSING' })}>Start processing</button>;
  }
  if (order.status === 'PROCESSING') {
    return <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
      <button type="button" className="btn btn--secondary btn--sm" disabled={statusMutation.isPending} onClick={() => statusMutation.mutate({ id: order.id, status: 'IN_PROGRESS' })}>Mark in progress</button>
      <button type="button" className="btn btn--primary btn--sm" onClick={() => onEnterResult(order)}>Enter result</button>
    </div>;
  }
  if (order.status === 'IN_PROGRESS') {
    return <button type="button" className="btn btn--primary btn--sm" onClick={() => onEnterResult(order)}>Enter result</button>;
  }
  return <span style={{ color: 'var(--muted)' }}>—</span>;
}

export function LabQueuePage() {
  const [searchParams] = useSearchParams();
  const selectedOrderId = searchParams.get('selectedOrder') || '';
  const selectedPatientId = searchParams.get('patientId') || '';
  const [search, setSearch] = useState(() => searchParams.get('search') || '');
  const [status, setStatus] = useState('ALL');
  const [selectedOrder, setSelectedOrder] = useState(null);
  const { data: orders = [], isLoading, error, refetch } = useLabOrders();
  const { data: catalog = [], isLoading: catalogLoading, error: catalogError, refetch: refetchCatalog } = useLabCatalog();
  const { data: results = [], isLoading: resultsLoading, error: resultsError, refetch: refetchResults } = useLabResults();
  const statusMutation = useOrderStatusMutation();
  const resultByTestId = useMemo(() => new Map(results.map((result) => [result.testId, result])), [results]);
  const catalogById = useMemo(() => new Map(catalog.map((item) => [item.id, item])), [catalog]);
  const rows = useMemo(() => orders
    .filter((order) => (status === 'ALL' ? !['COMPLETED', 'CANCELLED'].includes(order.status) : visibleByStatus(order, status)) && recordMatches(order, search))
    .sort((left, right) => {
      const leftSelected = left.id === selectedOrderId;
      const rightSelected = right.id === selectedOrderId;
      if (leftSelected !== rightSelected) return leftSelected ? -1 : 1;
      const leftPatientSelected = Boolean(selectedPatientId) && left.patientId === selectedPatientId;
      const rightPatientSelected = Boolean(selectedPatientId) && right.patientId === selectedPatientId;
      if (leftPatientSelected !== rightPatientSelected) return leftPatientSelected ? -1 : 1;
      return priorityScore(right.priority) - priorityScore(left.priority)
        || String(left.orderedDate || left.createdAt || '').localeCompare(String(right.orderedDate || right.createdAt || ''));
    }), [orders, search, status, selectedOrderId, selectedPatientId]);
  const pagination = usePaginatedRows(rows);

  if (isLoading || catalogLoading || resultsLoading) return <LoadingState message="Loading specimen and test queue…" />;
  if (error || catalogError || resultsError) return <ErrorState title="Failed to load the laboratory queue" error={error || catalogError || resultsError} onRetry={() => { refetch(); refetchCatalog(); refetchResults(); }} />;

  return (
    <div className="lab-module-page">
      <LabPageHeading title="Specimen & Test Queue" />
      <SearchAndStatus search={search} setSearch={setSearch} status={status} setStatus={setStatus} />
      <section className="glass card" style={PANEL_STYLE}>
        {rows.length === 0 ? (
          <EmptyState title={search || status !== 'ALL' ? 'No matching laboratory orders' : 'No laboratory orders'} description={search || status !== 'ALL' ? 'Adjust the search or status filter.' : 'New orders from clinicians will appear here.'} icon="icon-flask" />
        ) : (
          <TableFrame headers={['Priority', 'Ordered', 'Test', 'Patient', 'Ordering clinician / date', 'Status', 'Next action']} minWidth={1020}>
            {pagination.pageRows.map((order) => (
              <tr
                key={order.id}
                aria-selected={order.id === selectedOrderId}
              >
                <td><Badge variant={String(order.priority).toUpperCase() === 'STAT' ? 'danger' : String(order.priority).toUpperCase() === 'URGENT' ? 'warning' : 'neutral'}>{order.priority || 'Routine'}</Badge></td>
                <td>{formatDateTime(order.orderedDate || order.createdAt)}</td>
                <td><strong>{order.testName}</strong><br /><small>{order.testCode || '—'}</small></td>
                <td><strong>{order.patientName}</strong><br /><small>{order.patientMrn || order.patientId}</small></td>
                <td>{order.doctorName || '—'}<br /><small>{formatDate(order.orderedDate)}</small></td>
                <td><Badge status={order.status} /></td>
                <td><OrderAction order={order} onEnterResult={setSelectedOrder} statusMutation={statusMutation} /></td>
              </tr>
            ))}
          </TableFrame>
        )}
        <Pagination {...pagination} />
      </section>
      {selectedOrder && <ResultEntryDialog order={selectedOrder} catalog={catalogById.get(selectedOrder.testId)} existingResult={resultByTestId.get(selectedOrder.id)} onClose={() => setSelectedOrder(null)} />}
    </div>
  );
}

export function LabCompletedPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [date, setDate] = useState('');
  const [priority, setPriority] = useState('ALL');
  const { data: orders = [], isLoading, error, refetch } = useLabOrders();
  const { data: results = [], isLoading: resultsLoading, error: resultsError, refetch: refetchResults } = useLabResults();
  const resultByTestId = useMemo(() => new Map(results.map((result) => [result.testId, result])), [results]);
  const rows = useMemo(() => orders.filter((order) => {
    const result = resultByTestId.get(order.id);
    return order.status === 'COMPLETED' && result && recordMatches(order, search)
      && (!date || String(order.completedAt || result.resultDate || '').slice(0, 10) === date)
      && (priority === 'ALL' || order.priority === priority);
  }).sort((left, right) => String(right.completedAt || '').localeCompare(String(left.completedAt || ''))), [orders, resultByTestId, search, date, priority]);
  const pagination = usePaginatedRows(rows);

  if (isLoading || resultsLoading) return <LoadingState message="Loading completed tests…" />;
  if (error || resultsError) return <ErrorState title="Failed to load completed tests" error={error || resultsError} onRetry={() => { refetch(); refetchResults(); }} />;

  return (
    <div className="lab-module-page">
      <LabPageHeading title="Completed Tests" />
      <div className="glass card lab-filter-panel" style={PANEL_STYLE}>
        <label className="lab-filter-panel__search">
          <Icon name="icon-search" size={16} />
          <input className="form-input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search patient, ID, test, or order..." aria-label="Search completed tests" />
        </label>
        <label className="lab-filter-panel__field"><span>Completion date</span><input type="date" className="form-input" value={date} onChange={(event) => setDate(event.target.value)} /></label>
        <label className="lab-filter-panel__field"><span>Priority</span><select className="form-input" value={priority} onChange={(event) => setPriority(event.target.value)} aria-label="Filter by priority">
          <option value="ALL">All priorities</option>{[...new Set(orders.map((order) => order.priority).filter(Boolean))].map((value) => <option key={value}>{value}</option>)}
        </select></label>
      </div>
      <section className="glass card" style={PANEL_STYLE}>
        {rows.length === 0 ? <EmptyState title="No completed tests found" description="Completed orders appear here after a result has been saved." icon="icon-check-circle" /> : (
          <TableFrame headers={['Completed', 'Patient', 'Test', 'TAT (hours)', 'Flag', 'Action']} minWidth={900}>
            {pagination.pageRows.map((order) => {
              const result = resultByTestId.get(order.id);
              return <tr key={order.id}>
                <td>{formatDateTime(order.completedAt || result.resultDate)}</td>
                <td><strong>{order.patientName}</strong><br /><small>{order.patientMrn || order.patientId}</small></td>
                <td><strong>{order.testName}</strong></td>
                <td>{turnaroundHours(order) ?? '—'}</td>
                <td>{result.isCritical ? <Badge variant="danger">Critical</Badge> : '—'}</td>
                <td><button type="button" className="btn btn--secondary btn--sm" onClick={() => navigate(`/lab/results?id=${encodeURIComponent(order.id)}`)}>View Result</button></td>
              </tr>;
            })}
          </TableFrame>
        )}
        <Pagination {...pagination} />
      </section>
    </div>
  );
}

function LabReportView({ order, result, catalog, onBack }) {
  const parameters = Array.isArray(catalog?.parameters) ? catalog.parameters : [];
  const rows = Array.isArray(result?.results)
    ? result.results
    : Object.entries(result?.results || {}).map(([parameter, value]) => ({ parameter, value }));
  const definitions = new Map(parameters.map((parameter) => [parameter.name, parameter]));
  return (
    <div className="lab-module-page">
      <LabPageHeading title="Laboratory Report" />
      <section className="glass card lab-report-card" style={{ ...PANEL_STYLE, padding: '2rem' }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', borderBottom: '2px solid var(--primary)', paddingBottom: '1rem', marginBottom: '1.25rem' }}>
          <div><strong style={{ color: 'var(--primary)', fontSize: '1.3rem' }}>Clinova Healthcare</strong><div>Laboratory Report</div></div>
          <div><strong>Order {order.id}</strong><br />Reported {formatDateTime(order.completedAt || result.resultDate)}</div>
        </header>
        <div className="lab-report-meta" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.75rem', marginBottom: '1.25rem' }}>
          <div><strong>Patient:</strong> {order.patientName}<br /><strong>MRN:</strong> {order.patientMrn || order.patientId}</div>
          <div><strong>Referred by:</strong> {order.doctorName || '—'}<br /><strong>Technician:</strong> {result.performedByName || order.technicianName || '—'}</div>
          <div><strong>Sample collected:</strong> {formatDateTime(order.sampleCollectedAt)}<br /><strong>Reported:</strong> {formatDateTime(order.completedAt || result.resultDate)}</div>
        </div>
        <h2 style={{ textAlign: 'center', marginBottom: '1rem' }}>TEST: {order.testName}</h2>
        <TableFrame headers={['Investigation', 'Result', 'Reference range', 'Flag']} minWidth={640}>
          {rows.map((row, index) => {
            const definition = definitions.get(row?.parameter);
            const value = row && typeof row === 'object' ? row.value : row;
            const unit = (row && typeof row === 'object' ? row.unit : '') || definition?.unit || '';
            return <tr key={`${row?.parameter || 'result'}-${index}`}>
              <td>{row?.parameter || `Result ${index + 1}`}</td>
              <td><strong>{String(value ?? '—')} {unit}</strong></td>
              <td>{formatReferenceRange(definition)}</td>
              <td>{row?.flag ? <Badge variant={String(row.flag).toLowerCase().includes('critical') ? 'danger' : 'warning'}>{String(row.flag).replace(/_/g, ' ')}</Badge> : '—'}</td>
            </tr>;
          })}
        </TableFrame>
        {result.remarks && <p style={{ marginTop: '1rem' }}><strong>Technician remarks:</strong> {result.remarks}</p>}
        <footer style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '1rem', marginTop: '2rem', flexWrap: 'wrap' }}>
          <small>End of report · Generated by Clinova LIS</small><div style={{ textAlign: 'center', minWidth: '180px' }}><div style={{ borderBottom: '1px solid var(--text)', marginBottom: '0.4rem' }} /><strong>{result.performedByName || order.technicianName || 'Laboratory technician'}</strong><br /><small>Laboratory Technologist</small></div>
        </footer>
      </section>
      <div className="lab-report-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
        <button type="button" className="btn btn--secondary" onClick={onBack}>Back</button>
        <button type="button" className="btn btn--primary" onClick={() => printLabReport(order, result, catalog)}>Print / Save as PDF</button>
      </div>
    </div>
  );
}

export function LabResultsPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [date, setDate] = useState('');
  const [status, setStatus] = useState('ALL');
  const [category, setCategory] = useState('ALL');
  const [searchParams] = useSearchParams();
  const [selectedOrderId, setSelectedOrderId] = useState(null);
  const [dismissedOrderId, setDismissedOrderId] = useState(null);
  const { data: orders = [], isLoading: ordersLoading, error: ordersError, refetch: refetchOrders } = useLabOrders();
  const { data: results = [], isLoading: resultsLoading, error: resultsError, refetch: refetchResults } = useLabResults();
  const { data: catalog = [], isLoading: catalogLoading, error: catalogError, refetch: refetchCatalog } = useLabCatalog();
  const resultByTestId = useMemo(() => new Map(results.map((result) => [result.testId, result])), [results]);
  const catalogById = useMemo(() => new Map(catalog.map((item) => [item.id, item])), [catalog]);
  const requestedOrder = searchParams.get('orderId');
  const reportOrderId = searchParams.get('id');
  const requestedOrderRecord = orders.find((order) => order.id === requestedOrder);
  const autoSelectedOrder = requestedOrder !== dismissedOrderId
    && ['PROCESSING', 'IN_PROGRESS', 'COMPLETED'].includes(requestedOrderRecord?.status)
    ? requestedOrderRecord
    : null;
  const selectedOrder = orders.find((order) => order.id === selectedOrderId) || autoSelectedOrder;
  const closeResultDialog = () => {
    setSelectedOrderId(null);
    if (requestedOrder) setDismissedOrderId(requestedOrder);
  };
  const rows = useMemo(() => orders.filter((order) => {
    const result = resultByTestId.get(order.id);
    return recordMatches(order, search) && (status === 'ALL' || (status === 'COMPLETED' ? Boolean(result) : !result && visibleByStatus(order, status)))
      && (category === 'ALL' || catalogById.get(order.testId)?.category === category)
      && (!date || (result?.resultDate || order.orderedDate) === date);
  }), [orders, resultByTestId, search, status, date, category, catalogById]);
  const pagination = usePaginatedRows(rows);

  if (ordersLoading || resultsLoading || catalogLoading) return <LoadingState message="Loading laboratory results…" />;
  if (ordersError || resultsError || catalogError) return <ErrorState title="Failed to load laboratory results" error={ordersError || resultsError || catalogError} onRetry={() => { refetchOrders(); refetchResults(); refetchCatalog(); }} />;

  if (reportOrderId) {
    const reportOrder = orders.find((order) => order.id === reportOrderId);
    const reportResult = resultByTestId.get(reportOrderId);
    if (!reportOrder || reportOrder.status !== 'COMPLETED' || !reportResult) return <ErrorState title="Report not found or not finalized" error="This order has no finalized laboratory report." onRetry={() => { refetchOrders(); refetchResults(); }} />;
    return <LabReportView order={reportOrder} result={reportResult} catalog={catalogById.get(reportOrder.testId)} onBack={() => navigate('/lab/completed-tests')} />;
  }

  return (
    <div className="lab-module-page">
      <LabPageHeading title="Laboratory Results" />
      <div className="glass card lab-filter-panel" style={PANEL_STYLE}>
        <label className="lab-filter-panel__search">
          <Icon name="icon-search" size={16} />
          <input className="form-input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search patient, MRN, order, or test..." aria-label="Search laboratory results" />
        </label>
        <label className="lab-filter-panel__field"><span>Result date</span><input type="date" className="form-input" value={date} onChange={(event) => setDate(event.target.value)} /></label>
        <label className="lab-filter-panel__field"><span>Test type</span><select className="form-input" value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Filter by test category">
          <option value="ALL">All test types</option>{[...new Set(catalog.map((item) => item.category).filter(Boolean))].map((value) => <option key={value}>{value}</option>)}
        </select></label>
        <label className="lab-filter-panel__field"><span>Status</span><select className="form-input" value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Filter results by status">
          <option value="ALL">All statuses</option><option value="ORDERED">Awaiting collection</option><option value="SAMPLE_COLLECTED">Sample collected</option><option value="PROCESSING">Processing</option><option value="COMPLETED">Result recorded</option>
        </select></label>
      </div>
      <section className="glass card" style={PANEL_STYLE}>
        {rows.length === 0 ? <EmptyState title="No matching results or orders" description="Try another search or status filter." icon="icon-file-text" /> : (
          <TableFrame headers={['Order / test', 'Patient', 'Result date', 'Status', 'Action']} minWidth={760}>
            {pagination.pageRows.map((order) => {
              const result = resultByTestId.get(order.id);
              return <tr key={order.id}>
                <td><code>{order.id}</code><br /><strong>{order.testName}</strong></td>
                <td><strong>{order.patientName}</strong><br /><small>{order.patientMrn || order.patientId}</small></td>
                <td>{formatDate(result?.resultDate)}</td>
                <td>{result ? <Badge variant={result.isCritical ? 'danger' : 'success'}>{result.isCritical ? 'Critical flagged' : 'Recorded'}</Badge> : <Badge status={order.status} />}</td>
                <td>{result
                  ? <button type="button" className="btn btn--secondary btn--sm" onClick={() => navigate(`/lab/results?id=${encodeURIComponent(order.id)}`)}>View result</button>
                  : ['PROCESSING', 'IN_PROGRESS'].includes(order.status)
                    ? <button type="button" className="btn btn--secondary btn--sm" onClick={() => setSelectedOrderId(order.id)}>Enter result</button>
                    : '—'}</td>
              </tr>;
            })}
          </TableFrame>
        )}
        <Pagination {...pagination} />
      </section>
      {requestedOrder && !rows.some((order) => order.id === requestedOrder) && <p role="status" style={{ color: 'var(--muted)' }}>Order {requestedOrder} is not currently available for result entry.</p>}
      {selectedOrder && <ResultEntryDialog order={selectedOrder} catalog={catalogById.get(selectedOrder.testId)} existingResult={resultByTestId.get(selectedOrder.id)} onClose={closeResultDialog} />}
    </div>
  );
}

const isLabBillItem = (item) => ['LAB_TEST', 'LABTEST'].includes(String(item.itemType || item.type || '').toUpperCase());

export function LabBillingPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState(() => searchParams.get('search') || '');
  const [paymentStatus, setPaymentStatus] = useState('ALL');
  const [paymentMethod, setPaymentMethod] = useState('ALL');
  const [selectedBill, setSelectedBill] = useState(null);
  const [payBill, setPayBill] = useState(null);
  const [payAmountRupees, setPayAmountRupees] = useState('');
  const [payMethod, setPayMethod] = useState('UPI');
  const { data: bills = [], isLoading, error, refetch } = useQuery({
    queryKey: ['labBills'],
    queryFn: () => fetchAllPages(billsApi.list),
  });
  const paymentMutation = useMutation({
    mutationFn: ({ billId, amount, method, transactionRef }) => billsApi.receivePayment(billId, { amount, method, transactionRef }),
    onSuccess: () => {
      toast.success('Payment received successfully.');
      setPayBill(null);
      queryClient.invalidateQueries({ queryKey: ['labBills'] });
    },
    onError: (paymentError) => {
      toast.error(paymentError?.response?.data?.detail || 'Failed to record payment.');
    },
  });
  const labBills = useMemo(() => bills.map((bill) => {
    const items = bill.items || [];
    const labItems = items.filter(isLabBillItem);
    const labPaymentRef = `LAB_TEST_PAYMENT:${bill.id}`;
    const labOnly = items.length === labItems.length;
    const payments = labOnly ? (bill.payments || []) : (bill.payments || []).filter((payment) => payment.transactionRef === labPaymentRef);
    const labTotalAmount = labItems.reduce((total, item) => total + item.amount, 0);
    const labPaidAmount = bill.labOnly
      ? bill.paidAmount
      : payments.reduce((total, payment) => total + payment.amount, 0);
    const labBalanceDue = Math.max(0, labTotalAmount - labPaidAmount);
    return {
      ...bill,
      labItems,
      labTotalAmount,
      labOnly,
      labPayments: payments,
      labPaidAmount,
      labBalanceDue,
      labStatus: bill.status === 'CANCELLED' ? 'CANCELLED' : labBalanceDue === 0 ? 'PAID' : labPaidAmount > 0 ? 'PARTIAL' : 'UNPAID',
      labPayableAmount: Math.min(labBalanceDue, Math.max(0, bill.balanceDue ?? 0)),
    };
  })
    .filter((bill) => bill.labItems.length)
    .filter((bill) => paymentStatus === 'ALL' || bill.labStatus === paymentStatus)
    .filter((bill) => paymentMethod === 'ALL' || bill.labPayments.some((payment) => String(payment.paymentMethod || payment.method || '').toUpperCase() === paymentMethod))
    .filter((bill) => [bill.id, bill.patientName, bill.patientId, bill.patientMrn, ...bill.labItems.map((item) => item.description)].some((value) => String(value || '').toLowerCase().includes(search.trim().toLowerCase()))), [bills, search, paymentStatus, paymentMethod]);
  const pagination = usePaginatedRows(labBills);

  if (isLoading) return <LoadingState message="Loading lab invoices…" />;
  if (error) return <ErrorState title="Failed to load billing records" error={error} onRetry={refetch} />;

  const printBill = (bill) => {
    const items = bill.labItems.map((item) => `<tr><td>${escapeHtml(item.description)}</td><td style="text-align:right">${Format.money(item.amount)}</td></tr>`).join('');
    const payments = bill.labPayments.map((payment) => `<tr><td>${escapeHtml(formatDateTime(payment.createdAt))}</td><td>${escapeHtml(payment.paymentMethod || payment.method || '—')}</td><td>${Format.money(payment.amount)}</td></tr>`).join('');
    const paymentSummary = `<p>Status: ${escapeHtml(bill.labStatus)} · Lab test total: ${Format.money(bill.labTotalAmount)} · Paid: ${Format.money(bill.labPaidAmount)} · Balance: ${Format.money(bill.labBalanceDue)}</p>`;
    openPrintView(`Lab receipt ${bill.id}`, `<h1>Laboratory test receipt</h1><p>Invoice: ${escapeHtml(bill.id)} · ${escapeHtml(formatDate(bill.billDate || bill.createdAt))}</p><p>Patient: ${escapeHtml(bill.patientName)} · MRN ${escapeHtml(bill.patientMrn)}</p><table><thead><tr><th>Laboratory test</th><th>Amount</th></tr></thead><tbody>${items}</tbody></table>${payments ? `<h2>Payment history</h2><table><thead><tr><th>Date</th><th>Method</th><th>Amount</th></tr></thead><tbody>${payments}</tbody></table>` : ''}${paymentSummary}`);
  };
  const openPayModal = (bill) => {
    setPayBill(bill);
    setPayAmountRupees((bill.labPayableAmount / 100).toFixed(2));
    setPayMethod('UPI');
  };
  const submitPayment = (event) => {
    event.preventDefault();
    if (!payBill) return;

    const amountRupees = Number(payAmountRupees);
    const amountPaise = Math.round(amountRupees * 100);
    const balancePaise = payBill.labPayableAmount;
    if (!Number.isFinite(amountRupees) || amountPaise <= 0) {
      toast.error('Enter a valid payment amount.');
      return;
    }
    if (amountPaise > balancePaise) {
      toast.error(`Payment cannot exceed the balance due of ${Format.money(balancePaise)}.`);
      return;
    }

    paymentMutation.mutate({
      billId: payBill.id || payBill.bill_id,
      amount: amountPaise,
      method: payMethod,
      transactionRef: `LAB_TEST_PAYMENT:${payBill.id || payBill.bill_id}`,
    });
  };

  return (
    <div className="lab-module-page">
      <LabPageHeading title="Lab Billing & Receipts" />
      <div className="glass card lab-filter-panel" style={PANEL_STYLE}>
        <label className="lab-filter-panel__search">
          <Icon name="icon-search" size={16} />
          <input className="form-input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search patient or invoice..." aria-label="Search patient or invoice" />
        </label>
        <label className="lab-filter-panel__field"><span>Payment status</span><select className="form-input" value={paymentStatus} onChange={(event) => setPaymentStatus(event.target.value)} aria-label="Filter lab invoices by payment status">
          <option value="ALL">All payment statuses</option><option value="UNPAID">Unpaid</option><option value="PARTIAL">Partially paid</option><option value="PAID">Paid</option><option value="CANCELLED">Cancelled</option>
        </select></label>
        <label className="lab-filter-panel__field"><span>Payment method</span><select className="form-input" value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)} aria-label="Filter lab invoices by payment method">
          <option value="ALL">All payment methods</option><option value="CASH">Cash</option><option value="CARD">Card</option><option value="UPI">UPI</option><option value="OTHER">Other</option>
        </select></label>
      </div>
      <section className="glass card" style={PANEL_STYLE}>
        {labBills.length === 0 ? <EmptyState title="No laboratory invoices found" description={search || paymentStatus !== 'ALL' || paymentMethod !== 'ALL' ? 'Try a different search, payment status, or payment method.' : 'Invoices containing laboratory tests will appear here.'} icon="icon-receipt" /> : (
          <TableFrame headers={['Invoice #', 'Patient', 'Laboratory tests', 'Lab test price', 'Payment status', 'Payment method', 'Invoice date', 'Action']} minWidth={980}>
            {pagination.pageRows.map((bill) => {
              const methods = bill.labPayments.length
                ? [...new Set(bill.labPayments.map((payment) => payment.paymentMethod || payment.method).filter(Boolean))]
                  .map((method) => ({ CASH: 'Cash', CARD: 'Card', UPI: 'UPI', OTHER: 'Other' }[String(method).toUpperCase()] || method)).join(', ') || '—'
                : '—';
              return <tr key={bill.id}>
                <td><strong style={{ color: 'var(--primary)' }}>{bill.id}</strong></td>
                <td><strong>{bill.patientName}</strong><br /><small>{bill.patientMrn || bill.patientId}</small></td>
                <td>{bill.labItems.map((item) => item.description).filter(Boolean).join(', ')}</td>
                <td><strong>{Format.money(bill.labTotalAmount)}</strong><br /><small>Balance: {Format.money(bill.labBalanceDue)}</small></td>
                <td><Badge status={bill.labStatus} /></td><td>{methods}</td><td>{formatDate(bill.billDate || bill.createdAt)}</td>
                <td><div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <button type="button" className="btn btn--secondary btn--sm" onClick={() => setSelectedBill(bill)}>View receipt</button>
                  {bill.status !== 'CANCELLED' && bill.labPayableAmount > 0 && (
                    <button type="button" className="btn btn--primary btn--sm" onClick={() => openPayModal(bill)}>Pay</button>
                  )}
                </div></td>
              </tr>;
            })}
          </TableFrame>
        )}
        <Pagination {...pagination} />
        <p style={{ color: 'var(--muted)', fontSize: '0.8rem', margin: '1rem 0 0' }}>Lab technicians, Reception, and Admin accounts can record payments.</p>
      </section>
      {payBill && <Modal isOpen onClose={() => { if (!paymentMutation.isPending) setPayBill(null); }} title={`Record payment · ${payBill.id}`} size="md">
        <form onSubmit={submitPayment}>
          <p><strong>{payBill.patientName}</strong> · {payBill.patientMrn || payBill.patientId}</p>
          <p>Laboratory test balance: <strong>{Format.money(payBill.labBalanceDue)}</strong></p>
          <FormField label="Payment amount (₹)" required>
            <input
              className="form-input"
              type="number"
              step="0.01"
              min="0.01"
              max={(payBill.labPayableAmount / 100).toFixed(2)}
              value={payAmountRupees}
              onChange={(event) => setPayAmountRupees(event.target.value)}
              required
            />
          </FormField>
          <FormField label="Payment method" required>
            <select className="form-input" value={payMethod} onChange={(event) => setPayMethod(event.target.value)}>
              <option value="UPI">UPI</option>
              <option value="CARD">Credit / Debit Card</option>
              <option value="CASH">Cash</option>
            </select>
          </FormField>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '1.5rem' }}>
            <button type="button" className="btn btn--secondary" onClick={() => setPayBill(null)} disabled={paymentMutation.isPending}>Cancel</button>
            <button type="submit" className="btn btn--primary" disabled={paymentMutation.isPending}>
              {paymentMutation.isPending ? 'Processing…' : `Receive ${Format.money(Math.round(Number(payAmountRupees || 0) * 100))}`}
            </button>
          </div>
        </form>
      </Modal>}
      {selectedBill && <Modal isOpen onClose={() => setSelectedBill(null)} title={`Invoice ${selectedBill.id}`} size="lg">
        <p><strong>{selectedBill.patientName}</strong> · {selectedBill.patientMrn || selectedBill.patientId}</p>
        <p>Invoice date: {formatDate(selectedBill.billDate || selectedBill.createdAt)}{selectedBill.labOnly && <> · <Badge status={selectedBill.status} /></>}</p>
        <TableFrame headers={['Laboratory test', 'Amount']} minWidth={420}>
        {selectedBill.labItems.map((item) => <tr key={item.id}><td>{item.description}</td><td>{Format.money(item.amount)}</td></tr>)}
        </TableFrame>
        {selectedBill.labPayments.length > 0 && <>
          <h3 style={{ marginTop: '1rem' }}>Payment history</h3>
          <TableFrame headers={['Date', 'Method', 'Amount']} minWidth={420}>
            {selectedBill.labPayments.map((payment) => <tr key={payment.id}><td>{formatDateTime(payment.createdAt)}</td><td>{payment.paymentMethod || payment.method || '—'}</td><td>{Format.money(payment.amount)}</td></tr>)}
          </TableFrame>
        </>}
        <p><strong>Lab test total:</strong> {Format.money(selectedBill.labTotalAmount)} · <strong>Paid:</strong> {Format.money(selectedBill.labPaidAmount)} · <strong>Balance:</strong> {Format.money(selectedBill.labBalanceDue)}</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button type="button" className="btn btn--primary" onClick={() => printBill(selectedBill)}>Print receipt</button></div>
      </Modal>}
    </div>
  );
}

export function LabCatalogPage() {
  const { role } = useAuth();
  const canManageCatalog = role === 'LAB_TECH';
  const queryClient = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [viewing, setViewing] = useState(null);
  const [editor, setEditor] = useState(null);
  const [rangeForm, setRangeForm] = useState([]);
  const [formError, setFormError] = useState('');
  const { data: catalog = [], isLoading, error, refetch } = useLabCatalog();
  const rows = useMemo(() => catalog.filter((test) => [test.name, test.testName, test.code, test.category].some((value) => String(value || '').toLowerCase().includes(search.trim().toLowerCase()))), [catalog, search]);
  const pagination = usePaginatedRows(rows);

  const invalidateCatalog = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['labCatalog'] }),
      queryClient.invalidateQueries({ queryKey: ['doctorLabCatalog'] }),
      queryClient.invalidateQueries({ queryKey: ['adminLabCatalog'] }),
    ]);
  };
  const updateRangesMutation = useMutation({
    mutationFn: ({ id, parameters }) => labCatalogApi.update(id, { parameters }),
    onSuccess: async () => {
      toast.success('Test reference ranges updated.');
      setEditor(null);
      setFormError('');
      await invalidateCatalog();
    },
    onError: (saveError) => setFormError(saveError?.response?.data?.detail || JSON.stringify(saveError?.response?.data || 'Unable to update test ranges.')),
  });

  const openRangeEditor = (test) => {
    setRangeForm((test.parameters || []).map((parameter) => ({
      name: parameter.name,
      refMin: String(parameter.refMin ?? parameter.min ?? ''),
      refMax: String(parameter.refMax ?? parameter.max ?? ''),
      criticalMin: String(parameter.criticalMin ?? parameter.criticalLow ?? ''),
      criticalMax: String(parameter.criticalMax ?? parameter.criticalHigh ?? ''),
    })));
    setFormError('');
    setEditor({ mode: 'ranges', test });
  };

  const parseBounds = (parameter) => {
    const parsed = {};
    for (const key of ['refMin', 'refMax', 'criticalMin', 'criticalMax']) {
      const raw = String(parameter[key] ?? '').trim();
      if (!raw) {
        parsed[key] = null;
        continue;
      }
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`${parameter.name || 'Parameter'}: ${key} must be a valid number.`);
      parsed[key] = value;
    }
    if (parsed.refMin != null && parsed.refMax != null && parsed.refMin > parsed.refMax) {
      throw new Error(`${parameter.name || 'Parameter'}: reference minimum cannot exceed maximum.`);
    }
    return parsed;
  };

  const submitRangeUpdate = (event) => {
    event.preventDefault();
    setFormError('');
    let parameters;
    try {
      parameters = rangeForm.map((parameter) => ({
        name: parameter.name,
        ...parseBounds(parameter),
      }));
    } catch (validationError) {
      return setFormError(validationError.message);
    }
    updateRangesMutation.mutate({ id: editor.test.id, parameters });
  };

  if (isLoading) return <LoadingState message="Loading test catalog…" />;
  if (error) return <ErrorState title="Failed to load test catalog" error={error} onRetry={refetch} />;

  return (
    <div className="lab-module-page">
      <LabPageHeading
        title="Test Catalog"
      />
      <div className="glass card lab-filter-panel" style={PANEL_STYLE}>
        <label className="lab-filter-panel__search">
          <Icon name="icon-search" size={16} />
          <input className="form-input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search test name, code, or category..." aria-label="Search test catalog" />
        </label>
      </div>
      <section className="glass card" style={PANEL_STYLE}>
        {rows.length === 0 ? <EmptyState title="No catalog tests found" description="Try another test name or code." icon="icon-flask" /> : (
          <TableFrame headers={['Code', 'Test name / category', 'Price', 'Parameters', 'Action']} minWidth={canManageCatalog ? 850 : 700}>
            {pagination.pageRows.map((test) => <tr key={test.id}>
              <td><strong>{test.code || '—'}</strong></td><td><strong>{test.name || test.testName}</strong><br /><small>{test.category || '—'}</small></td>
              <td>{Format.money(test.price)}</td><td>{test.parameters?.length || 0} parameter(s)</td>
              <td className="lab-catalog-actions-cell">
                <div className="lab-catalog-actions">
                  <button type="button" className="btn btn--secondary btn--sm" onClick={() => setViewing(test)}>View Details</button>
                  {canManageCatalog && test.parameters?.length > 0 && <button type="button" className="btn btn--secondary btn--sm" onClick={() => openRangeEditor(test)}>Edit Ranges</button>}
                </div>
              </td>
            </tr>)}
          </TableFrame>
        )}
        <Pagination {...pagination} />
        {canManageCatalog && <p style={{ color: 'var(--muted)', fontSize: '0.8rem', margin: '1rem 0 0' }}>Lab Techs can edit reference and critical ranges. Admins manage the test catalog and billing prices.</p>}
      </section>
      {editor?.mode === 'ranges' && <Modal isOpen onClose={() => { if (!updateRangesMutation.isPending) setEditor(null); }} title={`Edit Ranges · ${editor.test.name || editor.test.testName}`} size="lg">
        <form className="lab-catalog-form" onSubmit={submitRangeUpdate}>
          <p className="lab-catalog-form__intro">Review and update the reporting limits for each parameter in this test.</p>
          {formError && <p className="lab-catalog-form__error" role="alert">{formError}</p>}
          <section className="lab-catalog-form__section" aria-labelledby="edit-ranges-heading">
            <div className="lab-catalog-form__section-heading">
              <span className="lab-catalog-form__step">1</span>
              <div>
                <h3 id="edit-ranges-heading">Reference & critical ranges</h3>
                <p>Blank limits are not applied when results are flagged</p>
              </div>
            </div>
            <div className="lab-catalog-form__parameters">
              {rangeForm.map((parameter, index) => (
                <section key={parameter.name} className="lab-catalog-form__parameter">
                  <div className="lab-catalog-form__parameter-heading">
                    <strong>{parameter.name}</strong>
                    {editor.test.parameters?.[index]?.unit && <span>{editor.test.parameters[index].unit}</span>}
                  </div>
                  <div className="lab-catalog-form__grid lab-catalog-form__grid--range-fields">
                    {[
                      ['refMin', 'Reference minimum', 'No lower limit'],
                      ['refMax', 'Reference maximum', 'No upper limit'],
                      ['criticalMin', 'Critical low', 'Optional'],
                      ['criticalMax', 'Critical high', 'Optional'],
                    ].map(([key, label, placeholder]) => <FormField key={key} label={label}><input className="form-input" type="number" step="any" placeholder={placeholder} value={parameter[key]} onChange={(event) => setRangeForm((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, [key]: event.target.value } : item))} /></FormField>)}
                  </div>
                </section>
              ))}
            </div>
          </section>
          <div className="lab-catalog-form__note"><strong>Range-only access</strong><span>Test details, parameter names, units, and billing price will not be changed.</span></div>
          <div className="lab-catalog-form__actions">
            <button type="button" className="btn btn--secondary" onClick={() => setEditor(null)} disabled={updateRangesMutation.isPending}>Cancel</button>
            <button type="submit" className="btn btn--primary" disabled={updateRangesMutation.isPending}>{updateRangesMutation.isPending ? 'Saving…' : 'Save Ranges'}</button>
          </div>
        </form>
      </Modal>}
      {viewing && <Modal isOpen onClose={() => setViewing(null)} title={viewing.name || viewing.testName}>
        <dl className="lab-catalog-details">
          {[
            ['Code', viewing.code || '—'],
            ['Category', viewing.category || '—'],
            ['Specimen', viewing.sampleType || '—'],
            ['Price', Format.money(viewing.price)],
            ['Turnaround', `${viewing.turnaroundHrs ?? '—'} hours`],
            ['Status', viewing.isActive === false ? 'Inactive' : 'Active'],
          ].map(([label, value]) => (
            <div className="lab-catalog-details__item" key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        {viewing.description && <p>{viewing.description}</p>}
        {Array.isArray(viewing.parameters) && viewing.parameters.length > 0 && <>
          <h3>Defined parameters and catalog ranges</h3>
          <TableFrame headers={['Parameter', 'Unit', 'Reference range', 'Critical range']} minWidth={600}>
            {viewing.parameters.map((parameter) => <tr key={parameter.name}>
              <td>{parameter.name}</td>
              <td>{parameter.unit || '—'}</td>
              <td>{formatReferenceRange(parameter, false)}</td>
              <td>
                {parameter.criticalMin != null || parameter.criticalMax != null
                  ? `${parameter.criticalMin != null ? `≤${parameter.criticalMin}` : ''}${parameter.criticalMin != null && parameter.criticalMax != null ? ' or ' : ''}${parameter.criticalMax != null ? `≥${parameter.criticalMax}` : ''}`
                  : 'Not specified'}
              </td>
            </tr>)}
          </TableFrame>
        </>}
      </Modal>}
    </div>
  );
}
