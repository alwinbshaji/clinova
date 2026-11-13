import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams, Link, useNavigate } from 'react-router-dom';
import {
  medicinesApi as sharedMedicinesApi,
  prescriptionsApi,
  stockLedgerApi,
  suppliersApi,
} from '../../api/resources';
import Icon from '../../components/Icon';
import Badge from '../../components/Badge';
import { ErrorState, EmptyState, LoadingState } from '../../components/States';
import { DataTable, Modal, FormField, ConfirmDialog } from '../../components/ui';
import { useToast } from '../../context/ToastContext';
import { Format, formatDate, formatDateTime } from '../../utils/format';
import PharmacyPageWrapper from './PharmacyPageWrapper';
import PharmacyDataTable, { PharmacyTableSkeleton } from './PharmacyDataTable';
import pharmacyDispensingApi from './pharmacyDispensingApi';
import medicinesApi from './pharmacyInventoryApi';
import pharmacyPurchaseApi from './pharmacyPurchaseApi';

// Preserve the upstream basic queue alongside the full pharmacy workflow.
export function PharmacyBasicQueuePage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [selectedPrescription, setSelectedPrescription] = useState(null);
  const [quantities, setQuantities] = useState({});
  const [dispenseErrors, setDispenseErrors] = useState({});
  const prescriptionsQuery = useQuery({
    queryKey: ['pharmacyPrescriptions'],
    queryFn: () => prescriptionsApi.list({ status: 'PENDING,PARTIALLY_DISPENSED', page_size: 200 }),
  });
  const medicinesQuery = useQuery({
    queryKey: ['pharmacyMedicineCatalogue'],
    queryFn: () => sharedMedicinesApi.list({ page_size: 500 }),
  });
  const prescriptions = Array.isArray(prescriptionsQuery.data) ? prescriptionsQuery.data : prescriptionsQuery.data?.results || [];
  const medicines = Array.isArray(medicinesQuery.data) ? medicinesQuery.data : medicinesQuery.data?.results || [];
  const medicinesById = useMemo(() => new Map(medicines.map((medicine) => [String(medicine.id), medicine])), [medicines]);
  const dispenseMutation = useMutation({
    mutationFn: ({ prescription, items }) => prescriptionsApi.dispense(prescription.id, { items }),
    onSuccess: () => {
      toast.success('Prescription dispensed and inventory updated.');
      setSelectedPrescription(null);
      setQuantities({});
      queryClient.invalidateQueries({ queryKey: ['pharmacyPrescriptions'] });
      queryClient.invalidateQueries({ queryKey: ['pharmacyMedicineCatalogue'] });
      queryClient.invalidateQueries({ queryKey: ['pharmacyDashboard'] });
      queryClient.invalidateQueries({ queryKey: ['pharmacyStockAlerts'] });
      queryClient.invalidateQueries({ queryKey: ['doctorPrescriptions'] });
      queryClient.invalidateQueries({ queryKey: ['doctorMedicineCatalogue'] });
    },
    onError: (error) => toast.error(error?.response?.data?.detail || 'Unable to dispense this prescription.'),
  });
  const openDispense = (prescription) => {
    setSelectedPrescription(prescription);
    setQuantities(Object.fromEntries((prescription.items || []).map((item) => [item.id, ''])));
    setDispenseErrors({});
  };
  const availableFor = (item) => {
    const medicine = medicinesById.get(String(item.medicineId));
    if (!medicine) return 0;
    const stock = Math.max(0, Number(medicine.stockQuantity) || 0);
    const batches = Array.isArray(medicine.batches) ? medicine.batches : [];
    if (!batches.length) return stock;
    const batchStock = batches.reduce((total, batch) => total + Math.max(0, Number(batch.quantity) || 0), 0);
    return Math.min(stock, batchStock);
  };
  const submitDispense = (event) => {
    event.preventDefault();
    if (!selectedPrescription?.items?.length) return;
    const items = selectedPrescription.items.map((item) => ({ itemId: item.id, quantity: Number(quantities[item.id]) }));
    const errors = Object.fromEntries(selectedPrescription.items.flatMap((item) => {
      const quantity = Number(quantities[item.id]);
      if (!Number.isInteger(quantity) || quantity < 1) return [[item.id, 'Enter a whole number greater than zero.']];
      if (quantity > availableFor(item)) return [[item.id, 'Quantity exceeds available stock.']];
      return [];
    }));
    if (Object.keys(errors).length) {
      setDispenseErrors(errors);
      return;
    }
    setDispenseErrors({});
    dispenseMutation.mutate({ prescription: selectedPrescription, items });
  };
  const columns = [
    { key: 'id', label: 'Prescription', sortable: true },
    { key: 'patientName', label: 'Patient', sortable: true },
    { key: 'doctorName', label: 'Doctor', sortable: true },
    { key: 'dateIssued', label: 'Issued', sortable: true, render: (row) => formatDate(row.dateIssued || row.createdAt) },
    { key: 'items', label: 'Medicines', render: (row) => (row.items || []).map((item) => item.medicineName || item.medicineId).join(', ') || '—' },
    { key: 'status', label: 'Status', render: (row) => <Badge status={row.status} /> },
    { key: 'actions', label: '', render: (row) => <button type="button" className="btn btn--primary btn--sm" onClick={() => openDispense(row)}>Review and dispense</button> },
  ];

  return (
    <div className="doctor-workspace">
      <div className="page-header">
        <div className="page-header__info"><h1 className="text-page-title">Prescription Dispensing Queue</h1><p className="text-caption">Review each order and enter the quantity dispensed for every medicine.</p></div>
      </div>
      <section className="glass card" style={{ padding: '1rem' }}>
        {prescriptionsQuery.isLoading || medicinesQuery.isLoading ? <LoadingState message="Loading prescriptions and stock..." />
          : prescriptionsQuery.error ? <ErrorState title="Unable to load prescriptions" error={prescriptionsQuery.error} onRetry={prescriptionsQuery.refetch} />
            : medicinesQuery.error ? <ErrorState title="Unable to load inventory" error={medicinesQuery.error} onRetry={medicinesQuery.refetch} />
              : <DataTable columns={columns} data={prescriptions} emptyTitle="No prescriptions awaiting dispensing" emptyMessage="New prescriptions from completed doctor visits will appear here." />}
      </section>
      <Modal isOpen={Boolean(selectedPrescription)} onClose={() => { if (!dispenseMutation.isPending) setSelectedPrescription(null); }} title={`Dispense ${selectedPrescription?.id || 'prescription'}`} size="lg" trapFocus>
        {selectedPrescription && <form onSubmit={submitDispense}>
          <p><strong>Patient:</strong> {selectedPrescription.patientName} &nbsp; <strong>Doctor:</strong> {selectedPrescription.doctorName}</p>
          {(selectedPrescription.items || []).map((item) => {
            const medicine = medicinesById.get(String(item.medicineId));
            const available = availableFor(item);
            return <div key={item.id} className="glass card" style={{ padding: '1rem', marginBottom: '.75rem' }}>
              <strong>{medicine?.name || item.medicineName || item.medicineId}</strong>{medicine?.strength ? ` · ${medicine.strength}` : ''}
              <p className="text-caption" style={{ margin: '.35rem 0' }}>{[item.dosage, item.frequency, item.durationDays ? `${item.durationDays} days` : null, item.instructions].filter(Boolean).join(' · ') || 'No additional directions'}</p>
              <p className="text-caption" style={{ margin: '.35rem 0' }}>Available stock: {available}{Array.isArray(medicine?.batches) && medicine.batches.length ? ` across ${medicine.batches.length} batches` : ''}</p>
              <label className="form-group__label" htmlFor={`dispense-${item.id}`}>Quantity to dispense</label>
              <input id={`dispense-${item.id}`} className="form-control" type="number" min="1" max={available} step="1" required aria-invalid={Boolean(dispenseErrors[item.id])} value={quantities[item.id] ?? ''} onChange={(event) => { setQuantities((current) => ({ ...current, [item.id]: event.target.value })); setDispenseErrors((current) => ({ ...current, [item.id]: undefined })); }} disabled={available < 1} />
              {dispenseErrors[item.id] && <span className="pharmacy-form-error" role="alert">{dispenseErrors[item.id]}</span>}
              {available < 1 && <p role="alert">No available stock. Replenish inventory before dispensing this medicine.</p>}
            </div>;
          })}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '.75rem' }}>
            <button type="button" className="btn btn--secondary" onClick={() => setSelectedPrescription(null)} disabled={dispenseMutation.isPending}>Cancel</button>
            <button type="submit" className="btn btn--primary" disabled={dispenseMutation.isPending || !(selectedPrescription.items || []).length || selectedPrescription.items.some((item) => availableFor(item) < 1)}>{dispenseMutation.isPending ? 'Dispensing…' : 'Confirm dispense'}</button>
          </div>
        </form>}
      </Modal>
    </div>
  );
}

const PAGE_SIZE = 200;
const MAX_ORDER_MONTHS = 3;
const PURCHASE_STATUS = {
  ORDERED: { label: 'Ordered', variant: 'info' },
  DELIVERED: { label: 'Delivered', variant: 'warning' },
  STOCKING: { label: 'Stocking', variant: 'success' },
  CANCELLED: { label: 'Cancelled', variant: 'neutral' },
};

function rowsFrom(data) {
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.results) ? data.results : [];
}

function errorText(error) {
  if (Array.isArray(error)) return error.join(' ');
  return typeof error === 'string' ? error : '';
}

function expiryDateWithinOneYear() {
  const today = new Date();
  const year = today.getFullYear() + 1;
  const month = today.getMonth();
  const day = Math.min(today.getDate(), new Date(year, month + 1, 0).getDate());
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function localDateString() {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
}

function nextLocalDateString() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
}

function expiryDateError(value) {
  if (!value) return 'Expiry date is required.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Enter a valid expiry date.';
  if (value <= localDateString()) return 'Expiry date must be in the future.';
  if (value > expiryDateWithinOneYear()) return 'Expiry date cannot be more than one year from today.';
  return '';
}

function localDateAfterMonths(months) {
  const today = new Date();
  const monthIndex = today.getMonth() + months;
  const year = today.getFullYear() + Math.floor(monthIndex / 12);
  const month = monthIndex % 12;
  const day = Math.min(today.getDate(), new Date(year, month + 1, 0).getDate());
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function supplierCatalogueRows(supplier, medicines) {
  const entries = Array.isArray(supplier?.typicalMedicines) ? supplier.typicalMedicines : [];
  return entries.flatMap((entry) => {
    const medicineId = typeof entry === 'string' ? entry : String(entry?.medicineId || entry?.id || '');
    const medicine = medicines.find((candidate) => candidate.id === medicineId);
    const cost = typeof entry === 'object' && entry
      ? Number(entry.fixedUnitPrice ?? entry.unitCost ?? entry.rate)
      : 0;
    if (!medicineId || !medicine || !medicine.isActive || !Number.isInteger(cost) || cost <= 0) return [];
    return [{ medicineId, name: medicine.name, strength: medicine.strength, unitCost: cost }];
  });
}

function supplierPriceInRupees(entry) {
  const priceInPaise = Number(entry?.fixedUnitPrice ?? entry?.unitCost ?? entry?.rate ?? 0);
  return Number.isInteger(priceInPaise) && priceInPaise > 0
    ? (priceInPaise / 100).toFixed(2)
    : '';
}

function validateMedicineForm(form, editingMed) {
  const errors = {};
  if (!form.name.trim()) errors.name = 'Enter a medicine name.';
  if (!form.genericName.trim()) errors.genericName = 'Enter the generic name.';
  if (!form.strength.trim()) errors.strength = 'Enter the medicine strength.';
  if (!form.unitPrice) errors.unitPrice = 'Enter a selling price.';
  const capacity = Number(form.counterCapacity);
  const threshold = Number(form.reorderThreshold);
  if (!Number.isInteger(capacity) || capacity < 1) {
    errors.counterCapacity = 'Counter capacity must be a positive whole number.';
  } else if (editingMed && capacity < (editingMed.counterStock ?? editingMed.stockQuantity ?? 0)) {
    errors.counterCapacity = 'Counter capacity cannot be less than the current counter stock.';
  }
  if (!Number.isInteger(threshold) || threshold < 1) {
    errors.reorderThreshold = 'Reorder level must be a positive whole number.';
  } else if (Number.isInteger(capacity) && threshold > capacity) {
    errors.reorderThreshold = 'Reorder level cannot exceed counter capacity.';
  }
  const price = Number(form.unitPrice);
  if (!Number.isFinite(price) || price <= 0 || !/^\d+(\.\d{1,2})?$/.test(form.unitPrice)) {
    errors.unitPrice = 'Enter a selling price greater than 0 with at most 2 decimals.';
  }
  return errors;
}

function medicinePayloadFromForm(form) {
  return {
    name: form.name.trim(),
    genericName: form.genericName.trim(),
    category: form.category,
    form: form.form,
    strength: form.strength.trim(),
    manufacturer: form.manufacturer.trim(),
    unitPrice: Math.round(Number(form.unitPrice) * 100),
    counterCapacity: Number(form.counterCapacity),
    reorderThreshold: Number(form.reorderThreshold),
  };
}

function emptyMedicineForm(name = '') {
  return {
    name,
    genericName: '',
    category: 'Analgesic',
    form: 'Tablet',
    strength: '',
    manufacturer: '',
    unitPrice: '',
    counterCapacity: '100',
    reorderThreshold: '25',
  };
}

function supplierCataloguePriceError(value) {
  if (!value.trim()) return 'Fixed unit price is required.';
  if (!/^\d+(\.\d{1,2})?$/.test(value) || Number(value) <= 0) {
    return 'Enter a price greater than 0 with at most 2 decimals.';
  }
  return '';
}

function MedicineFormFields({ medForm, setMedForm, medicineFormErrors, setMedicineFormErrors }) {
  return (
    <div className="pharmacy-form-grid">
      {medicineFormErrors.form && <p className="pharmacy-form-error" role="alert">{medicineFormErrors.form}</p>}
      <FormField label="Medicine Name *">
        <input
          type="text"
          className="form-input"
          aria-invalid={Boolean(medicineFormErrors.name)}
          value={medForm.name}
          onChange={(event) => { setMedForm({ ...medForm, name: event.target.value }); setMedicineFormErrors((current) => ({ ...current, name: undefined })); }}
          placeholder="e.g. Paracetamol 500mg"
        />
        {medicineFormErrors.name && <span className="pharmacy-form-error" role="alert">{medicineFormErrors.name}</span>}
      </FormField>
      <FormField label="Generic Name *">
        <input
          type="text"
          className="form-input"
          aria-invalid={Boolean(medicineFormErrors.genericName)}
          value={medForm.genericName}
          onChange={(event) => { setMedForm({ ...medForm, genericName: event.target.value }); setMedicineFormErrors((current) => ({ ...current, genericName: undefined })); }}
          placeholder="e.g. Paracetamol"
        />
        {medicineFormErrors.genericName && <span className="pharmacy-form-error" role="alert">{medicineFormErrors.genericName}</span>}
      </FormField>
      <FormField label="Category *">
        <select
          className="form-input"
          aria-invalid={Boolean(medicineFormErrors.category)}
          value={medForm.category}
          onChange={(event) => { setMedForm({ ...medForm, category: event.target.value }); setMedicineFormErrors((current) => ({ ...current, category: undefined })); }}
        >
          {CATEGORIES.filter((category) => category !== 'All').map((category) => (
            <option key={category} value={category}>{category}</option>
          ))}
        </select>
        {medicineFormErrors.category && <span className="pharmacy-form-error" role="alert">{medicineFormErrors.category}</span>}
      </FormField>
      <FormField label="Dosage Form *">
        <select
          className="form-input"
          aria-invalid={Boolean(medicineFormErrors.form)}
          value={medForm.form}
          onChange={(event) => { setMedForm({ ...medForm, form: event.target.value }); setMedicineFormErrors((current) => ({ ...current, form: undefined })); }}
        >
          {DOSAGE_FORMS.map((form) => <option key={form} value={form}>{form}</option>)}
        </select>
        {medicineFormErrors.form && <span className="pharmacy-form-error" role="alert">{medicineFormErrors.form}</span>}
      </FormField>
      <FormField label="Strength *">
        <input
          type="text"
          className="form-input"
          aria-invalid={Boolean(medicineFormErrors.strength)}
          value={medForm.strength}
          onChange={(event) => { setMedForm({ ...medForm, strength: event.target.value }); setMedicineFormErrors((current) => ({ ...current, strength: undefined })); }}
          placeholder="e.g. 500mg or 100mcg"
        />
        {medicineFormErrors.strength && <span className="pharmacy-form-error" role="alert">{medicineFormErrors.strength}</span>}
      </FormField>
      <FormField label="Manufacturer">
        <input
          type="text"
          className="form-input"
          aria-invalid={Boolean(medicineFormErrors.manufacturer)}
          value={medForm.manufacturer}
          onChange={(event) => { setMedForm({ ...medForm, manufacturer: event.target.value }); setMedicineFormErrors((current) => ({ ...current, manufacturer: undefined })); }}
          placeholder="e.g. Cipla, Sun Pharma"
        />
      </FormField>
      <FormField label="Selling Unit Price (₹) *">
        <input
          type="number"
          step="0.01"
          min="0.01"
          className="form-input"
          aria-invalid={Boolean(medicineFormErrors.unitPrice)}
          value={medForm.unitPrice}
          onChange={(event) => { setMedForm({ ...medForm, unitPrice: event.target.value }); setMedicineFormErrors((current) => ({ ...current, unitPrice: undefined })); }}
          placeholder="e.g. 2.50"
        />
        {medicineFormErrors.unitPrice && <span className="pharmacy-form-error" role="alert">{medicineFormErrors.unitPrice}</span>}
      </FormField>
      <FormField label="Counter Capacity *">
        <input
          type="number"
          min="1"
          step="1"
          className="form-input"
          aria-invalid={Boolean(medicineFormErrors.counterCapacity)}
          value={medForm.counterCapacity}
          onChange={(event) => {
            const capacity = event.target.value;
            setMedForm((current) => {
              const previousCapacity = Number(current.counterCapacity) || 100;
              const previousDefault = Math.max(1, Math.floor(previousCapacity * 0.25));
              const followsDefault = !current.reorderThreshold || Number(current.reorderThreshold) === previousDefault;
              return {
                ...current,
                counterCapacity: capacity,
                reorderThreshold: followsDefault
                  ? String(Math.max(1, Math.floor((Number(capacity) || 100) * 0.25)))
                  : current.reorderThreshold,
              };
            });
            setMedicineFormErrors((current) => ({ ...current, counterCapacity: undefined }));
          }}
        />
        <span className="text-caption">Default reorder level: {Math.max(1, Math.floor((Number(medForm.counterCapacity) || 100) * 0.25))} units (25%)</span>
        {medicineFormErrors.counterCapacity && <span className="pharmacy-form-error" role="alert">{medicineFormErrors.counterCapacity}</span>}
      </FormField>
      <FormField label="Reorder Threshold *">
        <input
          type="number"
          min="1"
          max={medForm.counterCapacity}
          step="1"
          className="form-input"
          aria-invalid={Boolean(medicineFormErrors.reorderThreshold)}
          value={medForm.reorderThreshold}
          onChange={(event) => {
            setMedForm({ ...medForm, reorderThreshold: event.target.value });
            setMedicineFormErrors((current) => ({ ...current, reorderThreshold: undefined }));
          }}
          placeholder="25"
        />
        {medicineFormErrors.reorderThreshold && <span className="pharmacy-form-error" role="alert">{medicineFormErrors.reorderThreshold}</span>}
      </FormField>
    </div>
  );
}

function batchIsExpiredOrUndated(batch) {
  const expiry = String(batch.expiryDate || '').slice(0, 10);
  return !/^\d{4}-\d{2}-\d{2}$/.test(expiry) || expiry < localDateString();
}

function batchIsSelectable(batch) {
  return Number(batch.quantity) > 0 && !batchIsExpiredOrUndated(batch);
}

function dosesPerDay(item) {
  const frequency = String(item.frequency || '').trim().toLowerCase();
  const frequencyAliases = [
    [/\b(four times|qid)\b/, 4],
    [/\b(thrice|three times|tid)\b/, 3],
    [/\b(twice|two times|bid)\b/, 2],
    [/\b(once|one time|od|qd)\b/, 1],
  ];
  for (const [pattern, count] of frequencyAliases) {
    if (pattern.test(frequency)) return count;
  }
  const interval = frequency.match(/\bq\s*(\d+)\s*h(?:ours?)?\b/);
  if (interval && Number(interval[1]) > 0) return 24 / Number(interval[1]);
  const timesPerDay = frequency.match(/(\d+(?:\.\d+)?)\s*(?:times?|x)\s*(?:a day|daily|per day)/);
  if (timesPerDay) return Number(timesPerDay[1]);
  if (/\b(daily|every day)\b/.test(frequency)) return 1;
  const regimen = String(item.dosage || '').match(/^\s*\d+(?:\.\d+)?(?:\s*[-/]\s*\d+(?:\.\d+)?)+\s*$/);
  if (regimen) {
    const total = regimen[0].split(/[-/]/).reduce((sum, dose) => sum + Number(dose), 0);
    if (total > 0) return total;
  }
  return null;
}

function daysForQuantity(quantity, item) {
  const amount = Number(quantity);
  const rate = dosesPerDay(item);
  return amount > 0 && rate ? Math.ceil(amount / rate) : 0;
}

function dispenseItemValues(item, selection = {}, preview = {}) {
  const remaining = preview.remainingQuantity ?? 0;
  const available = preview.availableQuantity ?? 0;
  const maxDispensable = Math.min(remaining, available);
  const defaultQuantity = Math.min(Number(item.quantity) || 0, maxDispensable);
  const frequencyRate = dosesPerDay(item);
  return {
    remaining,
    available,
    maxDispensable,
    defaultQuantity,
    quantity: selection.quantity ?? String(defaultQuantity),
    durationDays: selection.durationDays
      ?? String(frequencyRate ? daysForQuantity(defaultQuantity, item) : (item.durationDays || '')),
  };
}

function formatDispenseNote(note) {
  if (!note) return '—';
  try {
    const details = JSON.parse(note);
    if (details.prescriptionId) {
      const duration = details.durationDays ? ` · ${details.durationDays} day(s)` : '';
      return `Dispensed for Rx ${details.prescriptionId}${duration}`;
    }
  } catch {
    return note;
  }
  return note;
}

function dispensingPrintRows(prescription, dispensedItems) {
  return (prescription.items || []).map((item) => {
    const allocations = dispensedItems.filter((allocation) => allocation.itemId === item.id);
    return {
      item,
      quantity: allocations.reduce((total, allocation) => total + allocation.quantity, 0),
      durationDays: allocations[0]?.durationDays,
      batches: allocations.map((allocation) => `${allocation.batchNo || 'Unspecified'} (${allocation.quantity})`),
    };
  });
}

const CATEGORIES = ['All', 'Analgesic', 'Antibiotic', 'Antidiabetic', 'Antihypertensive', 'Antacid', 'Antihistamine', 'Bronchodilator', 'Statin', 'Other'];
const DOSAGE_FORMS = ['Tablet', 'Capsule', 'Syrup', 'Injection', 'Inhaler', 'Gel', 'Drops', 'Other'];

// =============================================================================
// 1. PRESCRIPTION QUEUE PAGE
// =============================================================================

export function PharmacyQueuePage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [queueSearchParams, setQueueSearchParams] = useSearchParams();
  const search = queueSearchParams.get('search') || '';
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [selectedRx, setSelectedRx] = useState(null);
  const [dispenseModalOpen, setDispenseModalOpen] = useState(false);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [printReceipt, setPrintReceipt] = useState(null);
  const [printingRxId, setPrintingRxId] = useState(null);
  const lastPrintedReceipt = useRef(null);
  const [paymentMethod, setPaymentMethod] = useState('CASH');
  const [paymentStatus, setPaymentStatus] = useState('PAID');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [dispenseSelections, setDispenseSelections] = useState({});
  const [dispenseErrors, setDispenseErrors] = useState({});

  const { data: prescriptions = [], isLoading, error, refetch } = useQuery({
    queryKey: ['prescriptionsQueue'],
    queryFn: async () => rowsFrom(await prescriptionsApi.list({ page_size: PAGE_SIZE })),
  });

  const {
    data: dispensePreview,
    isLoading: isDispensePreviewLoading,
    error: dispensePreviewError,
    refetch: refetchDispensePreview,
  } = useQuery({
    queryKey: ['pharmacyDispensePreview', selectedRx?.id],
    queryFn: () => pharmacyDispensingApi.preview(selectedRx.id),
    enabled: dispenseModalOpen && Boolean(selectedRx?.id),
  });
  const dispensePreviewByItem = useMemo(
    () => Object.fromEntries((dispensePreview?.items || []).map((item) => [item.itemId, item])),
    [dispensePreview],
  );

  useEffect(() => {
    if (!printReceipt || lastPrintedReceipt.current === printReceipt) return undefined;
    lastPrintedReceipt.current = printReceipt;
    const clearReceipt = () => {
      setPrintReceipt(null);
      setPrintingRxId(null);
    };
    window.addEventListener('afterprint', clearReceipt, { once: true });
    window.print();
    return () => window.removeEventListener('afterprint', clearReceipt);
  }, [printReceipt]);

  const filteredRx = useMemo(() => {
    return prescriptions.filter((rx) => {
      const matchesStatus = statusFilter === 'ALL' || rx.status === statusFilter;
      const q = search.toLowerCase().trim();
      const matchesSearch =
        !q ||
        rx.id?.toLowerCase().includes(q) ||
        rx.patientName?.toLowerCase().includes(q) ||
        rx.patientId?.toLowerCase().includes(q) ||
        rx.doctorName?.toLowerCase().includes(q);
      return matchesStatus && matchesSearch;
    });
  }, [prescriptions, statusFilter, search]);

  const handleOpenDispense = (rx) => {
    setSelectedRx(rx);
    setDispenseSelections({});
    setDispenseErrors({});
    setDispenseModalOpen(true);
  };

  const handleOpenView = (rx) => {
    setSelectedRx(rx);
    setViewModalOpen(true);
  };

  const handlePrintPrescription = async (rx) => {
    setPrintingRxId(rx.id);
    try {
      const result = await pharmacyDispensingApi.preview(rx.id);
      if (!result.dispensing?.items?.length) {
        toast.error('No completed dispensing record is available to print.');
        return;
      }
      setPrintReceipt({ prescription: rx, dispensing: result.dispensing });
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Unable to load the dispensing record for printing.');
    } finally {
      setPrintingRxId(null);
    }
  };

  const handleConfirmDispense = async () => {
    if (!selectedRx) return;
    const nextErrors = {};
    const payloadItems = (selectedRx.items || []).map((item) => {
      const itemId = item.id;
      const preview = dispensePreviewByItem[itemId];
      const selection = dispenseSelections[itemId] || {};
      const quantity = selection.quantity ?? Math.min(item.quantity || 0, preview?.remainingQuantity ?? item.quantity ?? 0, preview?.availableQuantity ?? 0);
      const durationDays = selection.durationDays ?? (Number(item.durationDays) || daysForQuantity(quantity, item));
      if (!Number.isInteger(Number(quantity)) || Number(quantity) < 0) {
        nextErrors[itemId] = 'Enter a whole-number quantity of at least 0.';
      } else if (Number(quantity) > (preview?.remainingQuantity ?? 0)) {
        nextErrors[itemId] = `Only ${preview?.remainingQuantity || 0} prescribed units remain.`;
      } else if (Number(quantity) > (preview?.availableQuantity ?? 0)) {
        nextErrors[itemId] = `Only ${preview?.availableQuantity || 0} non-expired units are available.`;
      } else if (Number(quantity) > 0 && (!Number.isInteger(Number(durationDays)) || Number(durationDays) < 1)) {
        nextErrors[itemId] = 'Days supply must be a whole number greater than 0.';
      }
      return { itemId, quantity: Number(quantity), durationDays: Number(durationDays) || 0 };
    });
    if (!payloadItems.some((item) => item.quantity > 0)) {
      nextErrors.form = 'Enter a quantity greater than 0 for at least one medicine.';
    }
    if (Object.keys(nextErrors).length) {
      setDispenseErrors(nextErrors);
      return;
    }
    setDispenseErrors({});
    setIsSubmitting(true);
    try {
      await pharmacyDispensingApi.dispense(selectedRx.id, {
        items: payloadItems,
        payment: { method: paymentMethod, status: paymentStatus },
      });
      toast.success(`Prescription ${selectedRx.id} dispensed successfully!`);
      setDispenseModalOpen(false);
      await refetch();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['pharmacyDashboard'] }),
        queryClient.invalidateQueries({ queryKey: ['stockLedgerHistory'] }),
        queryClient.invalidateQueries({ queryKey: ['pharmacyStockAlerts'] }),
        queryClient.invalidateQueries({ queryKey: ['pharmacyStockAlertsAll'] }),
      ]);
    } catch (err) {
      const serverErrors = err.response?.data?.errors;
      if (serverErrors) {
        setDispenseErrors(serverErrors);
      } else {
        toast.error(err.response?.data?.detail || 'Unable to dispense this prescription.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <PharmacyPageWrapper>
      <div className="page-header">
        <div className="page-header__info">
          <h1 className="text-page-title">Prescription Dispensing Queue</h1>
          <p className="text-caption">Review pending doctor orders, verify medications, and execute FEFO batch dispensing</p>
        </div>
      </div>

      <div className="glass card pharmacy-filter-panel">
        <div className="pharmacy-filter-panel__search">
          <Icon name="icon-search" size={16} />
          <input
            type="text"
            className="form-input"
            placeholder="Search by Rx ID, patient name, doctor..."
            value={search}
            onChange={(event) => {
              const nextParams = new URLSearchParams(queueSearchParams);
              if (event.target.value) nextParams.set('search', event.target.value);
              else nextParams.delete('search');
              setQueueSearchParams(nextParams, { replace: true });
            }}
          />
        </div>
        <div className="pharmacy-filter-panel__select">
          <span>Status:</span>
          <select className="form-input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="ALL">All Statuses</option>
            <option value="PENDING">Pending Dispense</option>
            <option value="PARTIALLY_DISPENSED">Partially Dispensed</option>
            <option value="DISPENSED">Dispensed</option>
          </select>
        </div>
      </div>

      <div className="glass card pharmacy-table-card">
        {isLoading ? (
          <PharmacyTableSkeleton columns={7} />
        ) : error ? (
          <ErrorState title="Unable to load prescriptions" error={error} onRetry={refetch} />
        ) : filteredRx.length === 0 ? (
          <EmptyState
            icon="icon-clipboard-list"
            title="No Prescriptions Found"
            message="No prescriptions match your current search and status filter."
          />
        ) : (
          <PharmacyDataTable
            className="pharmacy-data-table--queue"
            minWidth="900px"
            columns={[
              { width: '10%' },
              { width: '11%' },
              { width: '15%' },
              { width: '15%' },
              { width: '24%' },
              { width: '11%', align: 'center' },
              { width: '14%', align: 'right' },
            ]}
          >
              <thead>
                <tr>
                  <th>Rx ID</th>
                  <th>Date</th>
                  <th>Patient</th>
                  <th>Prescribing Doctor</th>
                  <th>Prescribed Items</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredRx.map((rx) => (
                  <tr key={rx.id}>
                    <td><code>{rx.id}</code></td>
                    <td>{formatDate(rx.dateIssued || rx.createdAt)}</td>
                    <td><strong>{rx.patientName || rx.patientId}</strong></td>
                    <td>{rx.doctorName || 'Attending Physician'}</td>
                    <td>
                      <span className="text-caption">
                        {rx.items?.length
                          ? rx.items.map((i) => `${i.medicineName || i.name} (${i.quantity})`).join(', ')
                          : 'No medicines listed'}
                      </span>
                    </td>
                    <td>
                      <Badge
                        variant={rx.status === 'DISPENSED' ? 'success' : 'info'}
                      >
                        {rx.status || 'PENDING'}
                      </Badge>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div className="pharmacy-table-actions" style={{ justifyContent: 'flex-end' }}>
                        <button type="button" className="btn btn--secondary btn--sm" onClick={() => handleOpenView(rx)}>
                          View
                        </button>
                        {['PARTIALLY_DISPENSED', 'DISPENSED'].includes(rx.status) && (
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            disabled={printingRxId === rx.id}
                            onClick={() => handlePrintPrescription(rx)}
                            aria-label={`Print dispensed prescription ${rx.id}`}
                          >
                            {printingRxId === rx.id ? 'Loading...' : 'Print'}
                          </button>
                        )}
                        {rx.status !== 'DISPENSED' && (
                          <button type="button" className="btn btn--primary btn--sm" onClick={() => handleOpenDispense(rx)}>
                            Dispense
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
          </PharmacyDataTable>
        )}
      </div>

      {/* Dispense Modal */}
      <Modal
        isOpen={dispenseModalOpen}
        onClose={() => setDispenseModalOpen(false)}
        title={`Dispense Prescription ${selectedRx?.id || ''}`}
        size="lg"
        footer={
          <>
            <button type="button" className="btn btn--secondary" onClick={() => setDispenseModalOpen(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn--primary" disabled={isSubmitting || isDispensePreviewLoading || Boolean(dispensePreviewError)} onClick={handleConfirmDispense}>
              {isSubmitting ? 'Dispensing...' : 'Confirm & Dispense'}
            </button>
          </>
        }
      >
        {selectedRx && (
          <div>
            <div style={{ marginBottom: '1.25rem', padding: '0.75rem 1rem', background: 'var(--bg-hover, rgba(0,0,0,0.03))', borderRadius: '8px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.5rem' }}>
                <div><strong>Patient:</strong> {selectedRx.patientName}</div>
                <div><strong>Doctor:</strong> {selectedRx.doctorName}</div>
                <div><strong>Date:</strong> {formatDate(selectedRx.dateIssued)}</div>
              </div>
            </div>

            <h4 style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: '0.5rem' }}>Items to Dispense</h4>
            <div style={{ marginBottom: '1.25rem' }}>
              <PharmacyDataTable
                className="pharmacy-order-items-table"
                minWidth="900px"
                columns={[
                  { width: '20%' },
                  { width: '18%' },
                  { width: '13%', align: 'right' },
                  { width: '15%', align: 'right' },
                  { width: '14%', align: 'right' },
                  { width: '20%' },
                ]}
              >
                <thead>
                  <tr>
                    <th>Medicine</th>
                    <th>Dosage / Instructions</th>
                    <th>Prescribed Qty</th>
                    <th>Dispensing Now</th>
                    <th>Days Supply</th>
                    <th>Batch Allocation (FEFO)</th>
                  </tr>
                </thead>
                <tbody>
                  {isDispensePreviewLoading ? (
                    <tr><td colSpan={6} className="text-caption">Checking remaining prescription and non-expired stock...</td></tr>
                  ) : dispensePreviewError ? (
                    <tr>
                      <td colSpan={6}>
                        <ErrorState title="Unable to check dispensing availability" error={dispensePreviewError} onRetry={refetchDispensePreview} />
                      </td>
                    </tr>
                  ) : selectedRx.items?.map((item) => {
                    const selection = dispenseSelections[item.id] || {};
                    const preview = dispensePreviewByItem[item.id] || {};
                    const {
                      remaining,
                      available,
                      maxDispensable,
                      defaultQuantity,
                      quantity,
                      durationDays,
                    } = dispenseItemValues(item, selection, preview);
                    const frequencyRate = dosesPerDay(item);
                    const isInactive = preview.isActive === false;
                    return (
                      <tr key={item.id}>
                        <td style={{ fontWeight: 600 }}>
                          {item.medicineName || item.name}
                          {isInactive && <span className="pharmacy-dispense__unavailable">Inactive</span>}
                        </td>
                        <td className="text-caption">
                          {item.dosage || '—'} · {item.frequency || 'Frequency not specified'}
                        </td>
                        <td className="pharmacy-dispense__reference">
                          <strong>{item.quantity} units</strong>
                          <span>{remaining} still prescribed</span>
                        </td>
                        <td>
                          <input
                            className="form-input pharmacy-dispense__input"
                            type="number"
                            min="0"
                            max={maxDispensable}
                            step="1"
                            aria-label={`Dispensing quantity for ${item.medicineName || item.name}`}
                            value={quantity}
                            disabled={isInactive || remaining === 0 || available === 0}
                            onChange={(event) => {
                              const value = event.target.value;
                              setDispenseSelections((current) => ({
                                ...current,
                                [item.id]: {
                                  quantity: value,
                                  durationDays: frequencyRate
                                    ? (value === '' ? '' : String(daysForQuantity(value, item)))
                                    : (selection.durationDays ?? String(item.durationDays || '')),
                                },
                              }));
                              setDispenseErrors((current) => ({ ...current, [item.id]: undefined, form: undefined }));
                            }}
                          />
                          <span className="pharmacy-dispense__availability">{available} non-expired available</span>
                        </td>
                        <td>
                          <input
                            className="form-input pharmacy-dispense__input"
                            type="number"
                            min="0"
                            step="1"
                            aria-label={`Days supply for ${item.medicineName || item.name}`}
                            value={durationDays}
                            disabled={isInactive || remaining === 0 || available === 0}
                            onChange={(event) => {
                              const value = event.target.value;
                              setDispenseSelections((current) => ({
                                ...current,
                                [item.id]: {
                                  quantity: frequencyRate
                                    ? (value === '' ? '' : String(Math.round(Number(value) * frequencyRate)))
                                    : (selection.quantity ?? String(defaultQuantity)),
                                  durationDays: value,
                                },
                              }));
                              setDispenseErrors((current) => ({ ...current, [item.id]: undefined, form: undefined }));
                            }}
                          />
                          <span className="pharmacy-dispense__availability">
                            {frequencyRate ? `${frequencyRate} dose(s) per day` : 'Frequency not recognized; adjust both fields manually'}
                          </span>
                        </td>
                        <td>
                          <span className="badge--fefo">Auto-allocated by earliest expiry</span>
                          {dispenseErrors[item.id] && (
                            <span className="pharmacy-dispense__error" role="alert">{dispenseErrors[item.id]}</span>
                          )}
                          {!isInactive && remaining > 0 && available === 0 && (
                            <span className="pharmacy-dispense__error">No non-expired stock available.</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </PharmacyDataTable>
            </div>
            {dispenseErrors.form && <p className="pharmacy-dispense__error" role="alert">{dispenseErrors.form}</p>}

            <div className="pharmacy-form-grid">
              <FormField label="Payment Method">
                <select className="form-input" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
                  <option value="CASH">Cash Payment</option>
                  <option value="UPI">UPI / Digital</option>
                  <option value="CARD">Debit / Credit Card</option>
                  <option value="INSURANCE">Health Insurance</option>
                </select>
              </FormField>
              <FormField label="Payment Status">
                <select className="form-input" value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value)}>
                  <option value="PAID">Paid / Cleared</option>
                  <option value="PENDING">Bill Later / Pending</option>
                </select>
              </FormField>
            </div>

          </div>
        )}
      </Modal>

      {/* View Details Modal */}
      <Modal
        isOpen={viewModalOpen}
        onClose={() => setViewModalOpen(false)}
        title={`Prescription Details — ${selectedRx?.id || ''}`}
        size="md"
        footer={<button type="button" className="btn btn--secondary" onClick={() => setViewModalOpen(false)}>Close</button>}
      >
        {selectedRx && (
          <div>
            <p><strong>Patient:</strong> {selectedRx.patientName}</p>
            <p><strong>Doctor:</strong> {selectedRx.doctorName}</p>
            <p><strong>Notes:</strong> {selectedRx.notes || 'None recorded'}</p>
            {selectedRx.dispensedBy && (
              <p><strong>Dispensed By:</strong> {selectedRx.dispensedByName || selectedRx.dispensedBy} at {formatDateTime(selectedRx.dispensedAt)}</p>
            )}
            <h4 style={{ marginTop: '1rem', marginBottom: '0.5rem' }}>Prescribed Medicines</h4>
            <ul>
              {selectedRx.items?.map((item, idx) => (
                <li key={idx} style={{ marginBottom: '0.25rem' }}>
                  <strong>{item.medicineName || item.name}</strong>: {item.quantity} units ({item.dosage}, {item.frequency})
                </li>
              ))}
            </ul>
          </div>
        )}
      </Modal>

      {printReceipt && (
        <section className="pharmacy-prescription-print" aria-hidden="true">
          <header className="pharmacy-prescription-print__header">
            <p className="pharmacy-prescription-print__eyebrow">Clinova Healthcare · Pharmacy</p>
            <h1>Dispensing Record</h1>
            <p>Dispensed {formatDateTime(printReceipt.dispensing?.dispensedAt)}</p>
          </header>
          <div className="pharmacy-prescription-print__details">
            <p><strong>Prescription ID:</strong> {printReceipt.prescription.id || '—'}</p>
            <p><strong>Prescription date:</strong> {formatDate(printReceipt.prescription.dateIssued || printReceipt.prescription.createdAt)}</p>
            <p><strong>Patient:</strong> {printReceipt.prescription.patientName || printReceipt.prescription.patientId || '—'}</p>
            <p><strong>Patient ID:</strong> {printReceipt.prescription.patientId || '—'}</p>
            <p><strong>Prescribing doctor:</strong> {printReceipt.prescription.doctorName || '—'}</p>
            <p><strong>Status:</strong> {printReceipt.dispensing?.status || printReceipt.prescription.status || '—'}</p>
            <p><strong>Allergies:</strong> {printReceipt.prescription.patientAllergies || 'None recorded'}</p>
          </div>
          {printReceipt.prescription.notes && (
            <p className="pharmacy-prescription-print__notes">
              <strong>Prescription notes:</strong> {printReceipt.prescription.notes}
            </p>
          )}
          <table>
            <thead>
              <tr>
                <th>Medicine</th>
                <th>Dosage / Frequency</th>
                <th>Instructions</th>
                <th>Duration prescribed</th>
                <th>Prescribed qty</th>
                <th>Dispensed now</th>
                <th>Days supply</th>
                <th>Batch allocation</th>
              </tr>
            </thead>
            <tbody>
              {dispensingPrintRows(
                printReceipt.prescription,
                printReceipt.dispensing?.items || [],
              ).map(({ item, quantity, durationDays, batches }) => (
                <tr key={item.id}>
                  <td>{item.medicineName || item.name || item.medicineId || '—'}</td>
                  <td>{[item.dosage, item.frequency].filter(Boolean).join(' · ') || '—'}</td>
                  <td>{item.instructions || '—'}</td>
                  <td>{item.durationDays ? `${item.durationDays} day(s)` : '—'}</td>
                  <td>{item.quantity ?? '—'} unit(s)</td>
                  <td>{quantity} unit(s)</td>
                  <td>{durationDays ? `${durationDays} day(s)` : '—'}</td>
                  <td>{batches.length ? batches.join(', ') : 'Not dispensed'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <footer className="pharmacy-prescription-print__footer">
            This record reflects the confirmed dispensing transaction.
          </footer>
        </section>
      )}
    </PharmacyPageWrapper>
  );
}

// =============================================================================
// 2. MEDICINE INVENTORY PAGE
// =============================================================================

export function PharmacyInventoryPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('All');
  const [medModalOpen, setMedModalOpen] = useState(false);
  const [pendingStatusMed, setPendingStatusMed] = useState(null);
  const [restockModalOpen, setRestockModalOpen] = useState(false);
  const [editingMed, setEditingMed] = useState(null);
  const [restockingMed, setRestockingMed] = useState(null);
  const [medicineFormErrors, setMedicineFormErrors] = useState({});
  const [restockFormErrors, setRestockFormErrors] = useState({});

  // Form states (Notice: No Cost Price field per requirement)
  const [medForm, setMedForm] = useState({
    name: '',
    genericName: '',
    category: 'Analgesic',
    form: 'Tablet',
    strength: '',
    manufacturer: '',
    unitPrice: '',
    counterCapacity: '100',
    reorderThreshold: '25',
  });

  const [restockForm, setRestockForm] = useState({
    quantity: '',
    batchNo: '',
    storageBatchNo: '',
  });

  const { data: medicines = [], isLoading, error, refetch } = useQuery({
    queryKey: ['medicinesList'],
    queryFn: async () => rowsFrom(await medicinesApi.list({ page_size: PAGE_SIZE })),
  });

  // Automatically trigger restock modal if navigated with ?restock=<id>
  useEffect(() => {
    const restockId = searchParams.get('restock');
    if (restockId && medicines?.length) {
      const target = medicines.find((m) => m.id === restockId);
      if (target) {
        handleOpenRestock(target);
      }
    }
  }, [searchParams, medicines]);

  const filteredMeds = useMemo(() => {
    return medicines.filter((m) => {
      const matchesCat = categoryFilter === 'All' || m.category === categoryFilter;
      const q = search.toLowerCase().trim();
      const matchesSearch =
        !q ||
        m.name?.toLowerCase().includes(q) ||
        m.genericName?.toLowerCase().includes(q) ||
        m.manufacturer?.toLowerCase().includes(q);
      return matchesCat && matchesSearch;
    });
  }, [medicines, categoryFilter, search]);

  const expiredRestockBatches = (restockingMed?.batches || []).filter(
    (batch) => Number(batch.quantity) > 0 && batchIsExpiredOrUndated(batch),
  );
  const storageBatches = (restockingMed?.batches || []).filter(
    (batch) => batch.location === 'STORAGE' && batchIsSelectable(batch),
  );
  const selectedStorageBatch = storageBatches.find((batch) => batch.batchNo === restockForm.storageBatchNo)
    || storageBatches[0];
  const counterSpace = Math.max(0, (restockingMed?.counterCapacity || 0) - (restockingMed?.counterStock ?? restockingMed?.stockQuantity ?? 0));

  const handleOpenAdd = () => {
    setEditingMed(null);
    setMedForm({
      name: '',
      genericName: '',
      category: 'Analgesic',
      form: 'Tablet',
      strength: '',
      manufacturer: '',
      unitPrice: '',
      counterCapacity: '100',
      reorderThreshold: '25',
    });
    setMedicineFormErrors({});
    setMedModalOpen(true);
  };

  const handleOpenEdit = (med) => {
    setEditingMed(med);
    // Unit price is stored in paise, converted to Rupees for display
    const priceInRupees = med.unitPrice ? (med.unitPrice / 100).toFixed(2) : '';
    setMedForm({
      name: med.name || '',
      genericName: med.genericName || '',
      category: med.category || 'Analgesic',
      form: med.form || 'Tablet',
      strength: med.strength || '',
      manufacturer: med.manufacturer || '',
      unitPrice: priceInRupees,
      counterCapacity: String(med.counterCapacity || 100),
      reorderThreshold: String(med.reorderThreshold ?? Math.max(1, Math.floor((med.counterCapacity || 100) * 0.25))),
    });
    setMedicineFormErrors({});
    setMedModalOpen(true);
  };

  const handleSaveMed = async () => {
    const errors = validateMedicineForm(medForm, editingMed);
    if (Object.keys(errors).length) {
      setMedicineFormErrors(errors);
      return;
    }
    setMedicineFormErrors({});

    const payload = medicinePayloadFromForm(medForm);

    try {
      if (editingMed) {
        await medicinesApi.update(editingMed.id, payload);
        toast.success(`Medicine ${medForm.name} updated.`);
      } else {
        await medicinesApi.create(payload);
        toast.success(`Medicine ${medForm.name} added to inventory.`);
      }
      setMedModalOpen(false);
      await Promise.all([
        refetch(),
        queryClient.invalidateQueries({ queryKey: ['medicinesDropdown'] }),
        queryClient.invalidateQueries({ queryKey: ['pharmacyStockAlerts'] }),
        queryClient.invalidateQueries({ queryKey: ['pharmacyStockAlertsAll'] }),
      ]);
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Unable to save medicine.');
    }
  };

  function handleOpenRestock(med) {
    setRestockingMed(med);
    const availableBatches = (med.batches || []).filter(
      (batch) => batch.location === 'STORAGE' && batchIsSelectable(batch),
    );
    setRestockForm({
      quantity: '',
      batchNo: availableBatches[0]?.batchNo || '',
      storageBatchNo: availableBatches[0]?.batchNo || '',
    });
    setRestockFormErrors({});
    setRestockModalOpen(true);
  }

  const handleRemoveExpiredBatches = async () => {
    if (!restockingMed) return;
    try {
      const result = await medicinesApi.removeExpired(restockingMed.id);
      setRestockingMed(result.medicine);
      toast.success(`Removed ${result.removed.reduce((sum, batch) => sum + batch.quantity, 0)} expired or undated units.`);
      await Promise.all([
        refetch(),
        queryClient.invalidateQueries({ queryKey: ['medicinesDropdown'] }),
        queryClient.invalidateQueries({ queryKey: ['stockLedgerHistory'] }),
        queryClient.invalidateQueries({ queryKey: ['pharmacyStockAlerts'] }),
        queryClient.invalidateQueries({ queryKey: ['pharmacyStockAlertsAll'] }),
        queryClient.invalidateQueries({ queryKey: ['pharmacyDashboard'] }),
      ]);
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Unable to remove expired batches.');
    }
  };

  const handleConfirmRestock = async () => {
    if (!restockingMed) return;
    const qty = Number(restockForm.quantity);
    const errors = {};
    if (expiredRestockBatches.length) {
      errors.expired = 'Remove expired or undated batches before transferring stock.';
    }
    if (isNaN(qty) || qty <= 0) {
      errors.quantity = 'Enter a positive whole-number quantity.';
    } else if (selectedStorageBatch && qty > Number(selectedStorageBatch.quantity)) {
      errors.quantity = `Only ${selectedStorageBatch.quantity} units are available in this storage batch.`;
    } else if (qty > counterSpace) {
      errors.quantity = `Only ${counterSpace} units of counter capacity remain.`;
    }
    if (!selectedStorageBatch) errors.storage = 'No eligible batch is available in storage.';
    if (Object.keys(errors).length) {
      setRestockFormErrors(errors);
      return;
    }

    try {
      const updated = await medicinesApi.restock(restockingMed.id, {
        quantity: qty,
        batchNo: selectedStorageBatch.batchNo,
      });
      toast.success(`Restocked ${qty} units of ${restockingMed.name}.`);
      setRestockingMed(updated);
      setRestockModalOpen(false);
      await Promise.all([
        refetch(),
        queryClient.invalidateQueries({ queryKey: ['medicinesDropdown'] }),
        queryClient.invalidateQueries({ queryKey: ['stockLedgerHistory'] }),
        queryClient.invalidateQueries({ queryKey: ['pharmacyStockAlerts'] }),
        queryClient.invalidateQueries({ queryKey: ['pharmacyStockAlertsAll'] }),
        queryClient.invalidateQueries({ queryKey: ['pharmacyDashboard'] }),
      ]);
    } catch (err) {
      if (err.response?.data?.code === 'STORAGE_EMPTY') {
        setRestockFormErrors({ storage: err.response.data.detail });
        return;
      }
      toast.error(err.response?.data?.detail || 'Unable to restock this medicine.');
    }
  };

  const handleToggleActive = async (med) => {
    try {
      await medicinesApi.toggleActive(med.id);
      toast.success(`Medicine ${med.isActive ? 'deactivated' : 'activated'}.`);
      await Promise.all([
        refetch(),
        queryClient.invalidateQueries({ queryKey: ['medicinesDropdown'] }),
        queryClient.invalidateQueries({ queryKey: ['pharmacyStockAlerts'] }),
        queryClient.invalidateQueries({ queryKey: ['pharmacyStockAlertsAll'] }),
        queryClient.invalidateQueries({ queryKey: ['pharmacyDashboard'] }),
      ]);
      setPendingStatusMed(null);
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Unable to update medicine status.');
    }
  };

  return (
    <PharmacyPageWrapper>
      <div className="page-header pharmacy-page-header pharmacy-inventory-header">
        <div className="page-header__info">
          <div className="pharmacy-page-heading">
            <span className="pharmacy-page-heading__icon">
              <Icon name="icon-package" size={21} />
            </span>
            <div>
              <p className="pharmacy-page-heading__eyebrow">PHARMACY · INVENTORY</p>
              <h1 className="text-page-title">Medication Inventory</h1>
              <p className="text-caption">Manage medicines, stock levels, pricing, and reorder thresholds.</p>
            </div>
          </div>
        </div>
        <div className="page-header__actions">
          <button type="button" className="btn btn--primary" onClick={handleOpenAdd}>
            <Icon name="icon-plus" size={16} />
            <span>Add Medicine</span>
          </button>
        </div>
      </div>

      <div className="glass card pharmacy-filter-panel">
        <div className="pharmacy-filter-panel__search">
          <Icon name="icon-search" size={16} />
          <input
            type="text"
            className="form-input"
            placeholder="Search by medicine name, generic, manufacturer..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="pharmacy-filter-panel__select">
          <span>Category:</span>
          <select className="form-input" value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
            {CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>{cat}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="glass card pharmacy-table-card">
        {isLoading ? (
          <PharmacyTableSkeleton columns={7} />
        ) : error ? (
          <ErrorState title="Unable to load medicine inventory" error={error} onRetry={refetch} />
        ) : filteredMeds.length === 0 ? (
          <EmptyState
            icon="icon-package"
            title="No Medications Found"
            message="No medicines matched your query. Click 'Add Medicine' to add a new inventory item."
          />
        ) : (
          <PharmacyDataTable
            className="pharmacy-data-table--inventory"
            minWidth="1320px"
            columns={[
              { width: '18%' },
              { width: '9%' },
              { width: '9%' },
              { width: '8%', align: 'right' },
              { width: '10%', align: 'right' },
              { width: '10%', align: 'right' },
              { width: '10%', align: 'right' },
              { width: '11%', align: 'center' },
              { width: '15%', align: 'right' },
            ]}
          >
              <thead>
                <tr>
                  <th>Medicine</th>
                  <th>Category</th>
                  <th>Dosage Form</th>
                  <th>Unit Price</th>
                  <th>Counter Stock</th>
                  <th>Storage Stock</th>
                  <th>Total Stock</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredMeds.map((m) => {
                  const counterQty = m.counterStock ?? m.stockQuantity ?? 0;
                  const storageQty = m.storageStock ?? 0;
                  const totalQty = m.totalStock ?? (counterQty + storageQty);
                  const threshold = m.reorderThreshold ?? Math.max(1, Math.floor((m.counterCapacity || 100) * 0.25));
                  const isOut = counterQty <= 0;
                  const isLow = counterQty <= threshold && !isOut;
                  const expiredBatches = (m.batches || []).filter(
                    (batch) => Number(batch.quantity) > 0 && batchIsExpiredOrUndated(batch),
                  );
                  const allExpired = Boolean(m.allBatchesExpired) || (
                    expiredBatches.length > 0
                    && (m.batches || []).filter((batch) => Number(batch.quantity) > 0).length === expiredBatches.length
                  );
                  const statusLabel = !m.isActive
                    ? 'Inactive'
                    : allExpired
                    ? 'Expired / Unavailable'
                    : isOut
                    ? 'Out of Counter Stock'
                    : isLow
                    ? 'Low Stock'
                    : 'Active';

                  return (
                    <tr key={m.id}>
                      <td>
                        <strong title={m.name}>{m.name}</strong>
                        <div className="text-caption" title={`${m.genericName || ''}${m.strength ? ` · ${m.strength}` : ''}`}>
                          {m.genericName} · {m.strength || ''}
                        </div>
                      </td>
                      <td>{m.category || '—'}</td>
                      <td>{m.form || 'Tablet'}</td>
                      <td><strong>{Format.money(m.unitPrice || 0)}</strong></td>
                      <td className="pharmacy-numeric-cell">
                        <strong className={isOut ? 'pharmacy-stock-value--critical' : isLow ? 'pharmacy-stock-value--low' : ''}>{counterQty} units</strong>
                        <div className="text-caption">Reorder at {threshold}</div>
                      </td>
                      <td className="pharmacy-numeric-cell">{storageQty} units</td>
                      <td className="pharmacy-numeric-cell"><strong>{totalQty} units</strong></td>
                      <td>
                        <Badge variant={!m.isActive ? 'neutral' : allExpired || isOut ? 'danger' : isLow ? 'warning' : 'success'}>
                          {statusLabel}
                        </Badge>
                        {expiredBatches.length > 0 && <div className="pharmacy-expiry-summary">{expiredBatches.length} expired/undated batch(es)</div>}
                      </td>
                      <td className="pharmacy-inventory-action-cell">
                        <div className="pharmacy-inventory-actions">
                          <button type="button" className="btn btn--primary btn--sm" onClick={() => handleOpenRestock(m)} disabled={!m.isActive}>
                            Restock
                          </button>
                          <button type="button" className="btn btn--secondary btn--sm" onClick={() => handleOpenEdit(m)}>
                            Edit
                          </button>
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm pharmacy-inventory-status-action"
                            onClick={() => {
                              if (m.isActive) setPendingStatusMed(m);
                              else handleToggleActive(m);
                            }}
                          >
                            {m.isActive ? 'Deactivate' : 'Activate'}
                          </button>
                          <details className="pharmacy-row-menu">
                            <summary className="btn btn--secondary btn--sm" aria-label={`More actions for ${m.name}`} title="More actions">
                              ⋯
                            </summary>
                            <div className="pharmacy-row-menu__items">
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.currentTarget.closest('details')?.removeAttribute('open');
                                  if (m.isActive) {
                                    setPendingStatusMed(m);
                                  } else {
                                    handleToggleActive(m);
                                  }
                                }}
                              >
                                {m.isActive ? 'Deactivate' : 'Activate'}
                              </button>
                            </div>
                          </details>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
          </PharmacyDataTable>
        )}
      </div>

      <ConfirmDialog
        isOpen={Boolean(pendingStatusMed)}
        onClose={() => setPendingStatusMed(null)}
        onConfirm={() => pendingStatusMed && handleToggleActive(pendingStatusMed)}
        title="Deactivate medicine?"
        message={`Deactivate ${pendingStatusMed?.name || 'this medicine'}? It will no longer be available for dispensing or purchase orders.`}
        confirmLabel="Deactivate"
        danger
      />

      {/* Add / Edit Medicine Modal */}
      <Modal
        isOpen={medModalOpen}
        onClose={() => setMedModalOpen(false)}
        title={editingMed ? 'Edit Medicine' : 'Add New Medicine'}
        size="lg"
        footer={
          <>
            <button type="button" className="btn btn--secondary" onClick={() => setMedModalOpen(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn--primary" onClick={handleSaveMed}>
              {editingMed ? 'Save Changes' : 'Create Medicine'}
            </button>
          </>
        }
      >
        <MedicineFormFields
          medForm={medForm}
          setMedForm={setMedForm}
          medicineFormErrors={medicineFormErrors}
          setMedicineFormErrors={setMedicineFormErrors}
        />
      </Modal>

      {/* Restock Modal */}
      <Modal
        isOpen={restockModalOpen}
        onClose={() => setRestockModalOpen(false)}
        title={`Restock Medication: ${restockingMed?.name || ''}`}
        size="md"
        footer={
          <>
            <button type="button" className="btn btn--secondary" onClick={() => setRestockModalOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={handleConfirmRestock}
              disabled={!restockingMed?.isActive || expiredRestockBatches.length > 0 || !selectedStorageBatch || counterSpace <= 0}
            >
              Confirm Restock
            </button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {!restockingMed?.isActive ? (
            <p className="pharmacy-form-error" role="alert">Inactive medicines cannot be restocked. Activate this medicine first.</p>
          ) : (
            <>
              <div className="pharmacy-stock-summary">
                <span>Counter: <strong>{restockingMed?.counterStock ?? restockingMed?.stockQuantity ?? 0}</strong></span>
                <span>Storage: <strong>{restockingMed?.storageStock ?? 0}</strong></span>
                <span>Counter space: <strong>{counterSpace}</strong></span>
              </div>

              {expiredRestockBatches.length > 0 && (
                <section className="pharmacy-expired-batches">
                  <div>
                    <h4>Step 1: Remove expired batches first</h4>
                    <p>Expired or undated stock must be removed before storage stock can be transferred.</p>
                  </div>
                  <ul>
                    {expiredRestockBatches.map((batch, index) => (
                      <li key={`${batch.batchNo}-${batch.location}-${index}`}>
                        <strong>{batch.batchNo || 'Unlabeled batch'}</strong>
                        <span>{batch.location || 'COUNTER'} · {batch.quantity} units · {batch.expiryDate || 'Expiry not recorded'}</span>
                      </li>
                    ))}
                  </ul>
                  {restockFormErrors.expired && <p className="pharmacy-form-error" role="alert">{restockFormErrors.expired}</p>}
                  <button type="button" className="btn btn--danger btn--sm" onClick={handleRemoveExpiredBatches}>
                    Remove expired batches
                  </button>
                </section>
              )}

              {expiredRestockBatches.length === 0 && storageBatches.length === 0 && (
                <div className="pharmacy-storage-empty">
                  <p>Not available in storage. Please place a purchase order.</p>
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => {
                      setRestockModalOpen(false);
                      navigate(`/pharmacy/purchases?medicine=${encodeURIComponent(restockingMed.id)}`);
                    }}
                  >
                    Place Purchase Order
                  </button>
                </div>
              )}

              {expiredRestockBatches.length === 0 && storageBatches.length > 0 && (
                <>
                  <h4 className="pharmacy-restock-step-title">Step 2: Transfer stock from Storage to Counter</h4>
                  {restockFormErrors.storage && <p className="pharmacy-form-error" role="alert">{restockFormErrors.storage}</p>}
                  <FormField label="Storage Batch *">
                    <select
                      className="form-input"
                      value={selectedStorageBatch?.batchNo || ''}
                      onChange={(event) => setRestockForm({
                        ...restockForm,
                        storageBatchNo: event.target.value,
                        batchNo: event.target.value,
                        quantity: '',
                      })}
                    >
                      {storageBatches.map((batch, index) => (
                        <option key={`${batch.batchNo}-${batch.expiryDate}-${index}`} value={batch.batchNo}>
                          {batch.batchNo} · {batch.quantity} units · expires {batch.expiryDate}
                        </option>
                      ))}
                    </select>
                  </FormField>
                  <FormField label="Quantity to Transfer *">
                    <input
                      type="number"
                      min="1"
                      max={Math.min(Number(selectedStorageBatch?.quantity || 0), counterSpace)}
                      step="1"
                      className="form-input"
                      value={restockForm.quantity}
                      onChange={(event) => {
                        setRestockForm({ ...restockForm, quantity: event.target.value });
                        setRestockFormErrors((current) => ({ ...current, quantity: undefined }));
                      }}
                    />
                    <span className="text-caption">Maximum {Math.min(Number(selectedStorageBatch?.quantity || 0), counterSpace)} units</span>
                    {restockFormErrors.quantity && <span className="pharmacy-form-error" role="alert">{restockFormErrors.quantity}</span>}
                  </FormField>
                  <FormField label="Batch expiry (from purchase record)">
                    <input type="date" className="form-input" value={selectedStorageBatch?.expiryDate || ''} readOnly />
                  </FormField>
                </>
              )}
            </>
          )}
        </div>
      </Modal>
    </PharmacyPageWrapper>
  );
}

// =============================================================================
// 3. PURCHASE ORDERS PAGE
// =============================================================================

export function PharmacyPurchasesPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [purchaseSearchParams, setPurchaseSearchParams] = useSearchParams();
  const preselectedMedicineId = purchaseSearchParams.get('medicine') || '';
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [receiveModalOpen, setReceiveModalOpen] = useState(false);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [selectedPo, setSelectedPo] = useState(null);
  const [pendingPurchaseAction, setPendingPurchaseAction] = useState(null);
  const [poFormErrors, setPoFormErrors] = useState({});
  const [expectedDeliveryDate, setExpectedDeliveryDate] = useState('');

  // New PO state
  const [poSupplierId, setPoSupplierId] = useState('');
  const [poNotes, setPoNotes] = useState('');
  const [poItems, setPoItems] = useState([]);
  const [itemMedId, setItemMedId] = useState(preselectedMedicineId);
  const [itemQty, setItemQty] = useState('100');

  // Receive PO state
  const [receiveBatchNos, setReceiveBatchNos] = useState([]);
  const [receiveQuantities, setReceiveQuantities] = useState([]);
  const [receiveExpiryDates, setReceiveExpiryDates] = useState([]);
  const [receiveErrors, setReceiveErrors] = useState({});
  const [receiveFormError, setReceiveFormError] = useState('');

  const {
    data: purchaseOrders = [],
    isLoading: purchaseOrdersLoading,
    error: purchaseOrdersError,
    refetch,
  } = useQuery({
    queryKey: ['purchaseOrdersList'],
    queryFn: async () => rowsFrom(await pharmacyPurchaseApi.list({ page_size: PAGE_SIZE })),
  });

  const {
    data: suppliers = [],
    isLoading: suppliersLoading,
    error: suppliersError,
  } = useQuery({
    queryKey: ['suppliersDropdown'],
    queryFn: async () => rowsFrom(await suppliersApi.list({ page_size: PAGE_SIZE })),
  });

  const {
    data: medicines = [],
    isLoading: medicinesLoading,
    error: medicinesError,
  } = useQuery({
    queryKey: ['medicinesDropdown'],
    queryFn: async () => rowsFrom(await medicinesApi.list({ page_size: PAGE_SIZE })),
  });

  const activeMedicines = useMemo(
    () => medicines.filter((medicine) => medicine.isActive),
    [medicines],
  );
  const selectedSupplier = suppliers.find((supplier) => supplier.id === poSupplierId);
  const supplierCatalogue = useMemo(
    () => supplierCatalogueRows(selectedSupplier, activeMedicines),
    [selectedSupplier, activeMedicines],
  );
  const inactiveReceiveItems = (selectedPo?.items || []).filter((item) => (
    medicines.some((medicine) => medicine.id === item.medicineId && !medicine.isActive)
  ));

  useEffect(() => {
    if (!preselectedMedicineId || suppliersLoading || medicinesLoading || suppliersError || medicinesError) return;
    const matchingSupplier = suppliers.find((supplier) => supplier.isActive && (
      supplierCatalogueRows(supplier, activeMedicines).some((entry) => entry.medicineId === preselectedMedicineId)
    ));
    if (!matchingSupplier) {
      toast.error('No active supplier catalogue contains the requested medicine.');
      setPurchaseSearchParams({}, { replace: true });
      return;
    }
    setPoSupplierId(matchingSupplier.id);
    setPoNotes('');
    setPoItems([]);
    setItemMedId(preselectedMedicineId);
    setItemQty('100');
    setExpectedDeliveryDate(localDateAfterMonths(1));
    setPoFormErrors({});
    setCreateModalOpen(true);
    setPurchaseSearchParams({}, { replace: true });
  }, [preselectedMedicineId, suppliersLoading, medicinesLoading, suppliersError, medicinesError, suppliers, activeMedicines, setPurchaseSearchParams, toast]);

  const filteredPos = useMemo(() => {
    return purchaseOrders.filter((po) => {
      const matchesStatus = statusFilter === 'ALL' || po.status === statusFilter;
      const q = search.toLowerCase().trim();
      const matchesSearch =
        !q ||
        po.id?.toLowerCase().includes(q) ||
        po.supplierName?.toLowerCase().includes(q) ||
        po.supplierId?.toLowerCase().includes(q);
      return matchesStatus && matchesSearch;
    });
  }, [purchaseOrders, statusFilter, search]);

  const handleOpenCreate = () => {
    const firstSupplier = suppliers.find((supplier) => supplier.isActive);
    const initialCatalogue = supplierCatalogueRows(firstSupplier, activeMedicines);
    setPoSupplierId(firstSupplier?.id || '');
    setPoNotes('');
    setPoItems([]);
    setItemMedId(initialCatalogue[0]?.medicineId || '');
    setItemQty('100');
    setExpectedDeliveryDate(localDateAfterMonths(1));
    setPoFormErrors({});
    setCreateModalOpen(true);
  };

  const handleAddItem = () => {
    const catalogueItem = supplierCatalogue.find((item) => item.medicineId === itemMedId);
    if (!catalogueItem) {
      setPoFormErrors({ medicine: 'Select a medicine from this supplier catalogue.' });
      return;
    }
    const qty = Number(itemQty);
    if (!Number.isInteger(qty) || qty <= 0) {
      setPoFormErrors({ quantity: 'Enter a positive whole-number quantity.' });
      return;
    }
    if (poItems.some((item) => item.medicineId === catalogueItem.medicineId)) {
      setPoFormErrors({ medicine: 'This medicine is already in the order.' });
      return;
    }

    setPoItems([
      ...poItems,
      {
        medicineId: catalogueItem.medicineId,
        name: catalogueItem.name,
        quantity: qty,
        unitCost: catalogueItem.unitCost,
        lineTotal: qty * catalogueItem.unitCost,
      },
    ]);
    setPoFormErrors({});
  };

  const handleRemoveItem = (idx) => {
    setPoItems(poItems.filter((_, i) => i !== idx));
  };

  const totalPoAmountPaise = useMemo(() => {
    return poItems.reduce((acc, it) => acc + (it.lineTotal || 0), 0);
  }, [poItems]);

  const handleSavePo = async () => {
    const supplierId = poSupplierId || suppliers[0]?.id || '';
    if (!supplierId) {
      setPoFormErrors({ supplier: 'Select a supplier.' });
      return;
    }
    if (poItems.length === 0) {
      setPoFormErrors({ items: 'Add at least one medication item to the order.' });
      return;
    }

    if (!expectedDeliveryDate || expectedDeliveryDate < localDateString() || expectedDeliveryDate > localDateAfterMonths(MAX_ORDER_MONTHS)) {
      setPoFormErrors({ expectedDate: `Expected delivery date must be within ${MAX_ORDER_MONTHS} months from today.` });
      return;
    }

    const supObj = suppliers.find((s) => s.id === supplierId);

    const payload = {
      supplierId,
      supplierName: supObj?.name,
      orderDate: localDateString(),
      expectedDate: expectedDeliveryDate,
      status: 'ORDERED',
      notes: poNotes.trim(),
      items: poItems,
    };

    try {
      await pharmacyPurchaseApi.create(payload);
      toast.success('Purchase order created successfully.');
      setCreateModalOpen(false);
      setPoFormErrors({});
      await queryClient.invalidateQueries({ queryKey: ['purchaseOrdersList'] });
    } catch (err) {
      const errors = err.response?.data?.items;
      if (errors && typeof errors === 'object') {
        const itemErrors = Object.entries(errors).map(([index, message]) => {
          const item = poItems[Number(index)];
          return item ? `${item.name}: ${message}` : message;
        });
        setPoFormErrors({ items: itemErrors.join(' ') });
        return;
      }
      setPoFormErrors({
        expectedDate: errorText(err.response?.data?.expectedDate),
        form: errorText(err.response?.data?.detail) || errorText(err.response?.data?.supplierId),
      });
    }
  };

  const handleOpenReceive = (po) => {
    setSelectedPo(po);
    setReceiveBatchNos((po.items || []).map((item, index) => item.batchNo || `BATCH-${po.id}-${index + 1}`));
    setReceiveExpiryDates((po.items || []).map((item) => item.deliveredExpiryDate || item.expiryDate || ''));
    setReceiveQuantities((po.items || []).map((item) => String(item.quantity || '')));
    setReceiveErrors({});
    setReceiveFormError('');
    setReceiveModalOpen(true);
  };

  const handleConfirmDelivery = async () => {
    if (!selectedPo) return;
    if (inactiveReceiveItems.length) {
      setReceiveFormError('Inactive medicines cannot be marked Delivered. Reactivate them before continuing.');
      return;
    }
    const errors = {};
    (selectedPo.items || []).forEach((item, index) => {
      const expiry = item.expiryDate || receiveExpiryDates[index];
      const quantity = Number(receiveQuantities[index]);
      if (!Number.isInteger(quantity) || quantity <= 0 || quantity > Number(item.quantity)) {
        errors[index] = `Enter a delivered quantity from 1 to ${item.quantity}.`;
        return;
      }
      if (!String(receiveBatchNos[index] || '').trim()) {
        errors[index] = 'Batch number is required.';
        return;
      }
      const error = expiryDateError(expiry);
      if (error) errors[index] = error;
    });
    if (Object.keys(errors).length) {
      setReceiveErrors(errors);
      setReceiveFormError('Correct the delivered quantity and batch details.');
      return;
    }

    try {
      const itemsPayload = (selectedPo.items || []).map((i, index) => ({
        medicineId: i.medicineId,
        quantity: Number(receiveQuantities[index]),
        batchNo: String(receiveBatchNos[index] || '').trim(),
        expiryDate: i.expiryDate || receiveExpiryDates[index],
      }));

      await pharmacyPurchaseApi.deliver(selectedPo.id, {
        items: itemsPayload,
      });
      toast.success(`Purchase Order ${selectedPo.id} marked Delivered. Stock has not been added yet.`);
      setReceiveModalOpen(false);
      setReceiveErrors({});
      setReceiveFormError('');
      await queryClient.invalidateQueries({ queryKey: ['purchaseOrdersList'] });
    } catch (err) {
      const serverErrors = err.response?.data?.errors;
      if (serverErrors) {
        const mappedErrors = {};
        (selectedPo.items || []).forEach((item, index) => {
          const itemError = serverErrors[item.medicineId];
          if (itemError) mappedErrors[index] = itemError;
        });
        setReceiveErrors(mappedErrors);
        setReceiveFormError(err.response?.data?.detail || 'Correct the delivered stock details.');
      } else {
        toast.error(err.response?.data?.detail || 'Unable to mark this purchase order Delivered.');
      }
    }
  };

  const handleConfirmPurchaseAction = async () => {
    if (!pendingPurchaseAction) return;
    const { type, po } = pendingPurchaseAction;
    try {
      if (type === 'cancel') {
        await pharmacyPurchaseApi.cancel(po.id);
        toast.success(`Purchase Order ${po.id} cancelled.`);
      } else if (type === 'stock') {
        await pharmacyPurchaseApi.stock(po.id);
        toast.success(`Purchase Order ${po.id} stocked into Storage.`);
      }
      setPendingPurchaseAction(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['purchaseOrdersList'] }),
        queryClient.invalidateQueries({ queryKey: ['medicinesDropdown'] }),
        queryClient.invalidateQueries({ queryKey: ['stockLedgerHistory'] }),
        queryClient.invalidateQueries({ queryKey: ['pharmacyStockAlertsAll'] }),
        queryClient.invalidateQueries({ queryKey: ['pharmacyDashboard'] }),
      ]);
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Unable to update purchase order status.');
    }
  };

  const purchaseActionLabel = pendingPurchaseAction?.type === 'cancel' ? 'Cancel Order' : 'Start Stocking';

  return (
    <PharmacyPageWrapper>
      <div className="page-header">
        <div className="page-header__info">
          <h1 className="text-page-title">Medication Purchase Orders</h1>
          <p className="text-caption">Supplier order requisition, delivery tracking, and receiving stock into pharmacy inventory</p>
        </div>
        <div className="page-header__actions">
          <button type="button" className="btn btn--primary" onClick={handleOpenCreate}>
            <Icon name="icon-plus" size={16} />
            <span>Create PO</span>
          </button>
        </div>
      </div>

      <div className="glass card pharmacy-filter-panel">
        <div className="pharmacy-filter-panel__search">
          <Icon name="icon-search" size={16} />
          <input
            type="text"
            className="form-input"
            placeholder="Search by PO ID, supplier name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="pharmacy-filter-panel__select">
          <span>Status:</span>
          <select className="form-input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="ALL">All Statuses</option>
            <option value="ORDERED">Ordered</option>
            <option value="DELIVERED">Delivered</option>
            <option value="STOCKING">Stocking</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        </div>
      </div>

      <div className="glass card pharmacy-table-card">
        {purchaseOrdersLoading ? (
          <PharmacyTableSkeleton columns={7} />
        ) : purchaseOrdersError ? (
          <ErrorState title="Unable to load purchase orders" error={purchaseOrdersError} onRetry={refetch} />
        ) : filteredPos.length === 0 ? (
          <EmptyState
            icon="icon-receipt"
            title="No Purchase Orders"
            message="No purchase orders match your search. Click 'Create PO' to start a new requisition."
          />
        ) : (
          <PharmacyDataTable
            className="pharmacy-data-table--purchase-orders"
            minWidth="900px"
            columns={[
              { width: '12%' },
              { width: '22%' },
              { width: '14%' },
              { width: '12%', align: 'right' },
              { width: '14%', align: 'right' },
              { width: '12%', align: 'center' },
              { width: '14%', align: 'right' },
            ]}
          >
              <thead>
                <tr>
                  <th>PO ID</th>
                  <th>Supplier</th>
                  <th>Order Date</th>
                  <th>Item Count</th>
                  <th>Total Amount</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredPos.map((po) => (
                  <tr key={po.id}>
                    <td><code>{po.id}</code></td>
                    <td><strong>{po.supplierName || po.supplierId}</strong></td>
                    <td>{formatDate(po.orderDate)}</td>
                    <td>{po.items?.length || 0} item(s)</td>
                    <td><strong>{Format.money(po.totalAmount || 0)}</strong></td>
                    <td>
                      <Badge variant={PURCHASE_STATUS[po.status]?.variant || 'neutral'}>
                        {PURCHASE_STATUS[po.status]?.label || po.status}
                      </Badge>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div className="pharmacy-table-actions" style={{ justifyContent: 'flex-end' }}>
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          onClick={() => {
                            setSelectedPo(po);
                            setViewModalOpen(true);
                          }}
                        >
                          View
                        </button>
                        {po.status === 'ORDERED' && (
                          <button
                            type="button"
                            className="btn btn--primary btn--sm"
                            onClick={() => handleOpenReceive(po)}
                          >
                            Mark Delivered
                          </button>
                        )}
                        {po.status === 'DELIVERED' && (
                          <button
                            type="button"
                            className="btn btn--primary btn--sm"
                            onClick={() => setPendingPurchaseAction({ type: 'stock', po })}
                          >
                            Start Stocking
                          </button>
                        )}
                        {po.status === 'ORDERED' && (
                          <button
                            type="button"
                            className="btn btn--ghost btn--sm"
                            onClick={() => setPendingPurchaseAction({ type: 'cancel', po })}
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
          </PharmacyDataTable>
        )}
      </div>

      {/* Create Purchase Order Modal */}
      <Modal
        isOpen={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        title="Create Purchase Order"
        size="lg"
        footer={
          <>
            <button type="button" className="btn btn--secondary" onClick={() => setCreateModalOpen(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn--primary" onClick={handleSavePo} disabled={suppliersLoading || medicinesLoading || suppliers.length === 0 || supplierCatalogue.length === 0}>
              Submit Purchase Order
            </button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {(suppliersError || medicinesError) && (
            <ErrorState
              title="Unable to load purchase-order options"
              error={suppliersError || medicinesError}
              onRetry={() => {
                queryClient.invalidateQueries({ queryKey: ['suppliersDropdown'] });
                queryClient.invalidateQueries({ queryKey: ['medicinesDropdown'] });
              }}
            />
          )}
          <div className="pharmacy-form-grid">
            <FormField label="Supplier *">
              <select
                className="form-input"
                aria-invalid={Boolean(poFormErrors.supplier)}
                value={poSupplierId || suppliers[0]?.id || ''}
                onChange={(e) => {
                  const nextSupplierId = e.target.value;
                  const nextSupplier = suppliers.find((supplier) => supplier.id === nextSupplierId);
                  const nextCatalogue = supplierCatalogueRows(nextSupplier, activeMedicines);
                  setPoSupplierId(nextSupplierId);
                  setPoItems([]);
                  setItemMedId(nextCatalogue[0]?.medicineId || '');
                  setPoFormErrors({});
                }}
              >
                {suppliers.filter((supplier) => supplier.isActive).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.id})
                  </option>
                ))}
              </select>
              {poFormErrors.supplier && <span className="pharmacy-form-error" role="alert">{poFormErrors.supplier}</span>}
            </FormField>
            <FormField label="Order Notes">
              <input
                type="text"
                className="form-input"
                placeholder="e.g. Monthly restock requisition"
                value={poNotes}
                onChange={(e) => setPoNotes(e.target.value)}
              />
            </FormField>
            <FormField label="Expected Delivery Date *">
              <input
                type="date"
                className="form-input"
                min={localDateString()}
                max={localDateAfterMonths(MAX_ORDER_MONTHS)}
                value={expectedDeliveryDate}
                onChange={(e) => {
                  setExpectedDeliveryDate(e.target.value);
                  setPoFormErrors((current) => ({ ...current, expectedDate: undefined }));
                }}
              />
              {poFormErrors.expectedDate && <span className="pharmacy-form-error" role="alert">{poFormErrors.expectedDate}</span>}
            </FormField>
          </div>

          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
            <h4 style={{ margin: '0 0 0.5rem 0', fontSize: '0.95rem' }}>Supplier Catalogue</h4>
            {supplierCatalogue.length === 0 ? (
              <EmptyState
                icon="icon-package"
                title="No catalogue items"
                message="This supplier has no active medicines with fixed prices in its catalogue."
              />
            ) : (
              <>
                <PharmacyDataTable
                  className="pharmacy-data-table--supplier-catalogue"
                  minWidth="520px"
                  columns={[
                    { width: '12%', align: 'center' },
                    { width: '58%' },
                    { width: '30%', align: 'right' },
                  ]}
                >
                  <thead>
                    <tr>
                      <th>Select</th>
                      <th>Medicine</th>
                      <th>Fixed Unit Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {supplierCatalogue.map((item) => (
                      <tr key={item.medicineId}>
                        <td>
                          <input
                            type="radio"
                            name="purchase-catalogue-medicine"
                            aria-label={`Select ${item.name}`}
                            checked={itemMedId === item.medicineId}
                            onChange={() => {
                              setItemMedId(item.medicineId);
                              setPoFormErrors((current) => ({ ...current, medicine: undefined }));
                            }}
                          />
                        </td>
                        <td>
                          <strong>{item.name}</strong>
                          {item.strength && <div className="text-caption">{item.strength}</div>}
                        </td>
                        <td className="pharmacy-numeric-cell"><strong>{Format.money(item.unitCost)}</strong></td>
                      </tr>
                    ))}
                  </tbody>
                </PharmacyDataTable>
                {poFormErrors.medicine && <p className="pharmacy-form-error" role="alert">{poFormErrors.medicine}</p>}
                <div className="pharmacy-purchase-add-line">
                  <FormField label="Quantity *">
                    <input
                      type="number"
                      min="1"
                      step="1"
                      className="form-input"
                      value={itemQty}
                      onChange={(e) => {
                        setItemQty(e.target.value);
                        setPoFormErrors((current) => ({ ...current, quantity: undefined }));
                      }}
                    />
                    {poFormErrors.quantity && <span className="pharmacy-form-error" role="alert">{poFormErrors.quantity}</span>}
                  </FormField>
                  <div className="pharmacy-purchase-add-line__price">
                    Unit cost is fixed by the supplier catalogue.
                    {supplierCatalogue.find((item) => item.medicineId === itemMedId) && (
                      <strong>{Format.money(supplierCatalogue.find((item) => item.medicineId === itemMedId).unitCost)} per unit</strong>
                    )}
                  </div>
                  <button type="button" className="btn btn--secondary" onClick={handleAddItem}>
                    Add Selected Medicine
                  </button>
                </div>
              </>
            )}
          </div>

          {poItems.length > 0 && (
            <div style={{ marginTop: '0.5rem' }}>
              <PharmacyDataTable
                className="pharmacy-data-table--purchases"
                minWidth="640px"
                columns={[
                  { width: '32%' },
                  { width: '12%', align: 'right' },
                  { width: '20%', align: 'right' },
                  { width: '24%', align: 'right' },
                  { width: '12%', align: 'right' },
                ]}
              >
                <thead>
                  <tr>
                    <th>Medicine</th>
                    <th>Qty</th>
                    <th>Fixed Cost</th>
                    <th>Subtotal</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {poItems.map((it, idx) => (
                    <tr key={idx}>
                      <td><strong>{it.name}</strong></td>
                      <td>{it.quantity}</td>
                      <td>{Format.money(it.unitCost)}</td>
                      <td><strong>{Format.money(it.lineTotal)}</strong></td>
                      <td style={{ textAlign: 'right' }}>
                        <button type="button" className="btn btn--ghost btn--icon" onClick={() => handleRemoveItem(idx)}>
                          <Icon name="icon-trash" size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </PharmacyDataTable>
              <div style={{ textAlign: 'right', marginTop: '0.75rem', fontSize: '1.05rem' }}>
                Total Order Amount: <strong>{Format.money(totalPoAmountPaise)}</strong>
              </div>
            </div>
          )}
          {poFormErrors.items && <p className="pharmacy-form-error" role="alert">{poFormErrors.items}</p>}
          {poFormErrors.form && <p className="pharmacy-form-error" role="alert">{poFormErrors.form}</p>}
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={Boolean(pendingPurchaseAction)}
        onClose={() => setPendingPurchaseAction(null)}
        onConfirm={handleConfirmPurchaseAction}
        title={pendingPurchaseAction?.type === 'cancel' ? 'Cancel purchase order?' : 'Move delivered goods to Storage?'}
        message={pendingPurchaseAction?.type === 'cancel'
          ? `Cancel ${pendingPurchaseAction?.po?.id || 'this order'}? No stock will be added.`
          : `Start stocking ${pendingPurchaseAction?.po?.id || 'this order'}? Confirmed delivered quantities will be added to Storage and recorded in the stock ledger.`}
        confirmLabel={purchaseActionLabel}
        danger={pendingPurchaseAction?.type === 'cancel'}
      />

      {/* Receive Stock Modal */}
      <Modal
        isOpen={receiveModalOpen}
        onClose={() => setReceiveModalOpen(false)}
        title={`Mark Delivery — PO ${selectedPo?.id || ''}`}
        size="md"
        footer={
          <>
            <button type="button" className="btn btn--secondary" onClick={() => setReceiveModalOpen(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn--primary" onClick={handleConfirmDelivery} disabled={inactiveReceiveItems.length > 0}>
              Confirm Delivered
            </button>
          </>
        }
      >
        {selectedPo && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <p><strong>Supplier:</strong> {selectedPo.supplierName || selectedPo.supplierId}</p>
            {inactiveReceiveItems.length > 0 && (
              <p className="pharmacy-form-error" role="alert">
                {inactiveReceiveItems.map((item) => item.name || item.medicineId).join(', ')} cannot be marked Delivered while inactive.
              </p>
            )}
            {receiveFormError && <p className="pharmacy-form-error" role="alert">{receiveFormError}</p>}
            <section className="pharmacy-receive-items">
              <h4>Confirm delivered quantities and batch details</h4>
              {(selectedPo.items || []).map((item, index) => (
                <div className="pharmacy-receive-item" key={`${item.medicineId}-${index}`}>
                  <div>
                    <strong>{item.name || medicines.find((medicine) => medicine.id === item.medicineId)?.name || item.medicineId}</strong>
                    <span>{item.quantity} units ordered</span>
                  </div>
                  <div className="pharmacy-delivery-fields">
                    <FormField label="Delivered Quantity *">
                      <input
                        type="number"
                        min="1"
                        max={item.quantity}
                        step="1"
                        className="form-input"
                        value={receiveQuantities[index] || ''}
                        onChange={(event) => {
                          const nextQuantities = [...receiveQuantities];
                          nextQuantities[index] = event.target.value;
                          setReceiveQuantities(nextQuantities);
                          setReceiveErrors((current) => ({ ...current, [index]: undefined }));
                        }}
                      />
                    </FormField>
                    <FormField label="Batch Number *">
                      <input
                        type="text"
                        className="form-input"
                        value={receiveBatchNos[index] || ''}
                        onChange={(event) => {
                          const nextBatchNos = [...receiveBatchNos];
                          nextBatchNos[index] = event.target.value;
                          setReceiveBatchNos(nextBatchNos);
                        }}
                      />
                    </FormField>
                    <FormField label="Expiry Date *">
                      <input
                        type="date"
                        className="form-input"
                        min={nextLocalDateString()}
                        max={expiryDateWithinOneYear()}
                        value={item.expiryDate || receiveExpiryDates[index] || ''}
                        readOnly={Boolean(item.expiryDate)}
                        onChange={(event) => {
                          const nextDates = [...receiveExpiryDates];
                          nextDates[index] = event.target.value;
                          setReceiveExpiryDates(nextDates);
                          setReceiveErrors((current) => ({ ...current, [index]: undefined }));
                        }}
                      />
                    </FormField>
                    {receiveErrors[index] && <span className="pharmacy-form-error" role="alert">{receiveErrors[index]}</span>}
                  </div>
                </div>
              ))}
            </section>
            <p className="text-caption">
              Marking Delivered records the receipt only. Stock is added to Storage when you start Stocking.
            </p>
          </div>
        )}
      </Modal>

      {/* View PO Details Modal */}
      <Modal
        isOpen={viewModalOpen}
        onClose={() => setViewModalOpen(false)}
        title={`PO Details — ${selectedPo?.id || ''}`}
        size="md"
        footer={<button type="button" className="btn btn--secondary" onClick={() => setViewModalOpen(false)}>Close</button>}
      >
        {selectedPo && (
          <div>
            <p><strong>Supplier:</strong> {selectedPo.supplierName || selectedPo.supplierId}</p>
            <p><strong>Order Date:</strong> {formatDate(selectedPo.orderDate)}</p>
            <p><strong>Expected Delivery:</strong> {formatDate(selectedPo.expectedDate)}</p>
            <p><strong>Status:</strong> {PURCHASE_STATUS[selectedPo.status]?.label || selectedPo.status}</p>
            <p><strong>Total:</strong> {Format.money(selectedPo.totalAmount || 0)}</p>
            <h4 style={{ marginTop: '1rem' }}>Order Line Items</h4>
            <ul>
              {selectedPo.items?.map((it, idx) => (
                <li key={idx}>
                  <strong>{it.name || it.medicineId}</strong>: {it.quantity || it.quantityOrdered} ordered @ fixed {Format.money(it.unitCost || 0)}
                  {it.deliveredQuantity != null && (
                    <span> · {it.deliveredQuantity} delivered · Batch {it.batchNo} · expires {it.deliveredExpiryDate}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Modal>
    </PharmacyPageWrapper>
  );
}

// =============================================================================
// 4. SUPPLIERS PAGE
// =============================================================================

export function PharmacySuppliersPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [supplierModalOpen, setSupplierModalOpen] = useState(false);
  const [newMedicineModalOpen, setNewMedicineModalOpen] = useState(false);
  const [ratesModalOpen, setRatesModalOpen] = useState(false);
  const [editingSup, setEditingSup] = useState(null);
  const [selectedSup, setSelectedSup] = useState(null);
  const [supplierCatalogue, setSupplierCatalogue] = useState([]);
  const [supplierCatalogueError, setSupplierCatalogueError] = useState('');
  const [supplierFormErrors, setSupplierFormErrors] = useState({});
  const [catalogueSearch, setCatalogueSearch] = useState('');
  const [debouncedCatalogueSearch, setDebouncedCatalogueSearch] = useState('');
  const [catalogueDropdownOpen, setCatalogueDropdownOpen] = useState(false);
  const [activeCatalogueResult, setActiveCatalogueResult] = useState(-1);
  const [cataloguePriceErrors, setCataloguePriceErrors] = useState({});
  const [newMedicineForm, setNewMedicineForm] = useState(emptyMedicineForm());
  const [newMedicineFormErrors, setNewMedicineFormErrors] = useState({});
  const catalogueSearchRef = useRef(null);
  const cataloguePriceRefs = useRef({});

  const [supForm, setSupForm] = useState({
    name: '',
    contactPerson: '',
    phone: '',
    email: '',
    address: '',
  });

  const { data: suppliers = [], isLoading, error, refetch } = useQuery({
    queryKey: ['suppliersList'],
    queryFn: async () => rowsFrom(await suppliersApi.list({ page_size: PAGE_SIZE })),
  });

  const { data: catalogueMedicines = [], isLoading: catalogueLoading } = useQuery({
    queryKey: ['medicinesDropdown'],
    queryFn: async () => rowsFrom(await medicinesApi.list({ page_size: PAGE_SIZE })),
  });
  const activeCatalogueMedicines = catalogueMedicines.filter((medicine) => medicine.isActive);
  useEffect(() => {
    const timeoutId = window.setTimeout(
      () => setDebouncedCatalogueSearch(catalogueSearch.trim().toLowerCase()),
      300,
    );
    return () => window.clearTimeout(timeoutId);
  }, [catalogueSearch]);

  const catalogueSearchResults = useMemo(() => {
    if (!debouncedCatalogueSearch) return [];
    return activeCatalogueMedicines.filter((medicine) => (
      [medicine.name, medicine.genericName, medicine.strength]
        .some((value) => String(value || '').toLowerCase().includes(debouncedCatalogueSearch))
    ));
  }, [activeCatalogueMedicines, debouncedCatalogueSearch]);
  const hasExactMedicineName = catalogueMedicines.some(
    (medicine) => String(medicine.name || '').trim().toLowerCase() === debouncedCatalogueSearch,
  );
  const hasInvalidCataloguePrice = supplierCatalogue.some(
    (entry) => supplierCataloguePriceError(entry.unitCost),
  );

  const filteredSuppliers = useMemo(() => {
    return suppliers.filter((s) => {
      const q = search.toLowerCase().trim();
      return (
        !q ||
        s.name?.toLowerCase().includes(q) ||
        s.contactPerson?.toLowerCase().includes(q) ||
        s.phone?.includes(q) ||
        s.id?.toLowerCase().includes(q)
      );
    });
  }, [suppliers, search]);

  const handleOpenAdd = () => {
    setEditingSup(null);
    setSupForm({ name: '', contactPerson: '', phone: '', email: '', address: '' });
    setSupplierCatalogue([]);
    setSupplierCatalogueError('');
    setSupplierFormErrors({});
    setCatalogueSearch('');
    setCataloguePriceErrors({});
    setSupplierModalOpen(true);
  };

  const handleOpenEdit = (sup) => {
    setEditingSup(sup);
    setSupForm({
      name: sup.name || '',
      contactPerson: sup.contactPerson || '',
      phone: sup.phone || '',
      email: sup.email || '',
      address: sup.address || '',
    });
    const catalogue = (sup.typicalMedicines || []).map((entry) => ({
      medicineId: typeof entry === 'string' ? entry : String(entry.medicineId || entry.id || ''),
      unitCost: typeof entry === 'object' && entry ? supplierPriceInRupees(entry) : '',
    })).filter((entry) => entry.medicineId);
    setSupplierCatalogue(catalogue);
    setSupplierCatalogueError('');
    setSupplierFormErrors({});
    setCatalogueSearch('');
    setCataloguePriceErrors(Object.fromEntries(catalogue
      .filter((entry) => !entry.unitCost)
      .map((entry) => [entry.medicineId, 'Fixed unit price is required.'])));
    setSupplierModalOpen(true);
  };

  const handleAddCatalogueMedicine = (medicine) => {
    if (supplierCatalogue.some((entry) => entry.medicineId === medicine.id)) return;
    setSupplierCatalogueError('');
    setSupplierCatalogue((current) => [
      { medicineId: medicine.id, unitCost: '' },
      ...current,
    ]);
    setCataloguePriceErrors((current) => ({
      ...current,
      [medicine.id]: 'Fixed unit price is required.',
    }));
    setCatalogueSearch('');
    setDebouncedCatalogueSearch('');
    setCatalogueDropdownOpen(false);
    setActiveCatalogueResult(-1);
    window.setTimeout(() => cataloguePriceRefs.current[medicine.id]?.focus(), 0);
  };

  const handleRemoveCatalogueMedicine = (medicineId) => {
    setSupplierCatalogue((current) => current.filter((entry) => entry.medicineId !== medicineId));
    setCataloguePriceErrors((current) => {
      const next = { ...current };
      delete next[medicineId];
      return next;
    });
  };

  const openAddNewMedicine = () => {
    const name = catalogueSearch.trim();
    if (!name) return;
    setNewMedicineForm(emptyMedicineForm(name));
    setNewMedicineFormErrors({});
    setNewMedicineModalOpen(true);
    setCatalogueDropdownOpen(false);
  };

  const handleCreateMedicineForSupplier = async () => {
    const errors = validateMedicineForm(newMedicineForm, null);
    if (Object.keys(errors).length) {
      setNewMedicineFormErrors(errors);
      return;
    }
    setNewMedicineFormErrors({});
    try {
      const createdMedicine = await medicinesApi.create(medicinePayloadFromForm(newMedicineForm));
      if (!createdMedicine?.id) {
        throw new Error('The medicine was created without an ID.');
      }
      queryClient.setQueryData(['medicinesDropdown'], (current) => {
        const rows = rowsFrom(current);
        return rows.some((medicine) => medicine.id === createdMedicine.id)
          ? rows.map((medicine) => medicine.id === createdMedicine.id ? createdMedicine : medicine)
          : [createdMedicine, ...rows];
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['medicinesList'] }),
        queryClient.invalidateQueries({ queryKey: ['medicinesDropdown'] }),
        queryClient.invalidateQueries({ queryKey: ['pharmacyStockAlertsAll'] }),
      ]);
      setNewMedicineModalOpen(false);
      setCatalogueSearch('');
      handleAddCatalogueMedicine(createdMedicine);
      toast.success(`${createdMedicine.name} added to inventory and this supplier catalogue.`);
    } catch (err) {
      toast.error(err.response?.data?.detail || err.message || 'Unable to add medicine.');
    }
  };

  const handleSaveSupplier = async () => {
    const errors = {};
    if (!supForm.name.trim()) {
      errors.name = 'Enter a supplier business name.';
    }
    if (supForm.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supForm.email.trim())) {
      errors.email = 'Enter a valid email address.';
    }
    if (supForm.phone.trim() && !/^[+\d()\s-]{7,20}$/.test(supForm.phone.trim())) {
      errors.phone = 'Enter a valid phone number.';
    }
    setSupplierFormErrors(errors);
    if (Object.keys(errors).length) {
      return;
    }
    const priceErrors = Object.fromEntries(supplierCatalogue.map((entry) => [
      entry.medicineId,
      supplierCataloguePriceError(entry.unitCost),
    ]).filter(([, message]) => message));
    setCataloguePriceErrors(priceErrors);
    if (Object.keys(priceErrors).length) {
      setSupplierCatalogueError('Enter a valid fixed unit price for each catalogue medicine.');
      return;
    }

    const payload = {
      name: supForm.name.trim(),
      contactPerson: supForm.contactPerson.trim(),
      phone: supForm.phone.trim(),
      email: supForm.email.trim(),
      address: supForm.address.trim(),
      typicalMedicines: supplierCatalogue.map((entry) => {
        return {
          medicineId: entry.medicineId,
          fixedUnitPrice: Math.round(Number(entry.unitCost) * 100),
        };
      }),
    };

    try {
      if (editingSup) {
        await suppliersApi.update(editingSup.id, payload);
        toast.success(`Supplier ${payload.name} updated.`);
      } else {
        await suppliersApi.create(payload);
        toast.success(`Supplier ${payload.name} added.`);
      }
      setSupplierModalOpen(false);
      await Promise.all([
        refetch(),
        queryClient.invalidateQueries({ queryKey: ['suppliersDropdown'] }),
      ]);
    } catch (err) {
      const catalogueError = err.response?.data?.typicalMedicines;
      if (catalogueError) {
        setSupplierCatalogueError(errorText(catalogueError));
      } else {
        toast.error(err.response?.data?.detail || 'Unable to save supplier details.');
      }
    }
  };

  return (
    <PharmacyPageWrapper>
      <div className="page-header">
        <div className="page-header__info">
          <h1 className="text-page-title">Medicine Suppliers</h1>
          <p className="text-caption">Approved pharmaceutical wholesalers, contact directories, and supply contracts</p>
        </div>
        <div className="page-header__actions">
          <button type="button" className="btn btn--primary" onClick={handleOpenAdd}>
            <Icon name="icon-plus" size={16} />
            <span>New Supplier</span>
          </button>
        </div>
      </div>

      <div className="glass card pharmacy-filter-panel">
        <div className="pharmacy-filter-panel__search">
          <Icon name="icon-search" size={16} />
          <input
            type="text"
            className="form-input"
            placeholder="Search suppliers by name, contact, phone..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="glass card pharmacy-table-card">
        {isLoading ? (
          <PharmacyTableSkeleton columns={6} />
        ) : error ? (
          <ErrorState title="Unable to load suppliers" error={error} onRetry={refetch} />
        ) : filteredSuppliers.length === 0 ? (
          <EmptyState
            icon="icon-users"
            title="No Suppliers Found"
            description={suppliers.length ? 'No registered suppliers match your search.' : 'Add a supplier to manage pharmacy orders and supplier contacts.'}
            action={
              suppliers.length === 0 && (
                <button type="button" className="btn btn--primary" onClick={handleOpenAdd}>
                  <Icon name="icon-plus" size={16} />
                  Add Supplier
                </button>
              )
            }
          />
        ) : (
          <PharmacyDataTable
            className="pharmacy-data-table--suppliers pharmacy-suppliers-table"
            minWidth="1120px"
            columns={[
              { width: '20%' },
              { width: '14%' },
              { width: '21%' },
              { width: '20%' },
              { width: '9%', align: 'center' },
              { width: '16%', align: 'right' },
            ]}
          >
              <thead>
                <tr>
                  <th>Supplier Name</th>
                  <th>Contact Person</th>
                  <th>Phone / Email</th>
                  <th>Address</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredSuppliers.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <strong title={s.name}>{s.name}</strong>
                      <div className="text-caption" title={s.id}>{s.id}</div>
                    </td>
                    <td title={s.contactPerson || '—'}>{s.contactPerson || '—'}</td>
                    <td>
                      <div title={s.phone || '—'}>{s.phone || '—'}</div>
                      <div className="text-caption" title={s.email || ''}>{s.email || '—'}</div>
                    </td>
                    <td style={{ maxWidth: '280px' }} className="text-caption" title={s.address || '—'}>
                      {s.address || '—'}
                    </td>
                    <td>
                      <Badge variant={s.isActive ? 'success' : 'neutral'}>
                        {s.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div className="pharmacy-table-actions">
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          title={`View details for ${s.name}`}
                          onClick={() => {
                            setSelectedSup(s);
                            setRatesModalOpen(true);
                          }}
                        >
                          Details
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          title={`Edit ${s.name}`}
                          onClick={() => handleOpenEdit(s)}
                        >
                          Edit
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
          </PharmacyDataTable>
        )}
      </div>

      {/* Add / Edit Supplier Modal */}
      <Modal
        isOpen={supplierModalOpen}
        onClose={() => setSupplierModalOpen(false)}
        title={editingSup ? 'Edit Supplier' : 'Register New Supplier'}
        size="lg"
        footer={
          <>
            <button type="button" className="btn btn--secondary" onClick={() => setSupplierModalOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={handleSaveSupplier}
              disabled={hasInvalidCataloguePrice}
            >
              {editingSup ? 'Save Changes' : 'Register Supplier'}
            </button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <FormField label="Supplier Business Name *">
            <input
              type="text"
              className="form-input"
              aria-invalid={Boolean(supplierFormErrors.name)}
              value={supForm.name}
              onChange={(e) => { setSupForm({ ...supForm, name: e.target.value }); setSupplierFormErrors((current) => ({ ...current, name: undefined })); }}
              placeholder="e.g. Apex Pharma Distributors"
            />
            {supplierFormErrors.name && <span className="pharmacy-form-error" role="alert">{supplierFormErrors.name}</span>}
          </FormField>
          <FormField label="Contact Person">
            <input
              type="text"
              className="form-input"
              value={supForm.contactPerson}
              onChange={(e) => setSupForm({ ...supForm, contactPerson: e.target.value })}
              placeholder="e.g. Rajesh Sharma"
            />
          </FormField>
          <div className="pharmacy-form-grid">
            <FormField label="Phone Number">
              <input
                type="text"
                className="form-input"
                aria-invalid={Boolean(supplierFormErrors.phone)}
                value={supForm.phone}
                onChange={(e) => { setSupForm({ ...supForm, phone: e.target.value }); setSupplierFormErrors((current) => ({ ...current, phone: undefined })); }}
                placeholder="+91 98765 43210"
              />
              {supplierFormErrors.phone && <span className="pharmacy-form-error" role="alert">{supplierFormErrors.phone}</span>}
            </FormField>
            <FormField label="Email Address">
              <input
                type="email"
                className="form-input"
                aria-invalid={Boolean(supplierFormErrors.email)}
                value={supForm.email}
                onChange={(e) => { setSupForm({ ...supForm, email: e.target.value }); setSupplierFormErrors((current) => ({ ...current, email: undefined })); }}
                placeholder="orders@supplier.in"
              />
              {supplierFormErrors.email && <span className="pharmacy-form-error" role="alert">{supplierFormErrors.email}</span>}
            </FormField>
          </div>
          <FormField label="Office / Warehouse Address">
            <input
              type="text"
              className="form-input"
              value={supForm.address}
              onChange={(e) => setSupForm({ ...supForm, address: e.target.value })}
              placeholder="e.g. Plot 45, Industrial Estate, Mumbai"
            />
          </FormField>
          <section className="pharmacy-supplier-catalogue-editor">
            <div>
              <h4>Supplier Catalogue & Fixed Prices</h4>
              <p>Select medicines this supplier provides and set each fixed supplier price. The medicine selling price in Inventory is separate.</p>
            </div>
            <div className="pharmacy-catalogue-search">
              <label className="pharmacy-catalogue-search__label" htmlFor="supplier-catalogue-search">
                Search medicine to add to this supplier's catalogue...
              </label>
              <input
                ref={catalogueSearchRef}
                id="supplier-catalogue-search"
                type="text"
                className="form-input"
                role="combobox"
                aria-label="Search medicine to add to this supplier's catalogue..."
                aria-expanded={catalogueDropdownOpen}
                aria-controls="supplier-catalogue-search-results"
                aria-activedescendant={activeCatalogueResult >= 0 ? `supplier-catalogue-option-${activeCatalogueResult}` : undefined}
                placeholder="Search medicine to add to this supplier's catalogue..."
                value={catalogueSearch}
                onFocus={() => setCatalogueDropdownOpen(true)}
                onChange={(event) => {
                  setCatalogueSearch(event.target.value);
                  setCatalogueDropdownOpen(true);
                  setActiveCatalogueResult(-1);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.stopPropagation();
                    setCatalogueDropdownOpen(false);
                    setCatalogueSearch('');
                    setDebouncedCatalogueSearch('');
                    return;
                  }
                  const canCreate = Boolean(debouncedCatalogueSearch) && !hasExactMedicineName;
                  const optionCount = catalogueSearchResults.length + Number(canCreate);
                  if (event.key === 'ArrowDown' && optionCount > 0) {
                    event.preventDefault();
                    setCatalogueDropdownOpen(true);
                    setActiveCatalogueResult((current) => {
                      let next = current;
                      for (let attempt = 0; attempt < optionCount; attempt += 1) {
                        next = (next + 1) % optionCount;
                        if (next >= catalogueSearchResults.length
                          || !supplierCatalogue.some((entry) => entry.medicineId === catalogueSearchResults[next].id)) {
                          return next;
                        }
                      }
                      return current;
                    });
                  } else if (event.key === 'ArrowUp' && optionCount > 0) {
                    event.preventDefault();
                    setCatalogueDropdownOpen(true);
                    setActiveCatalogueResult((current) => {
                      let next = current;
                      for (let attempt = 0; attempt < optionCount; attempt += 1) {
                        next = next <= 0 ? optionCount - 1 : next - 1;
                        if (next >= catalogueSearchResults.length
                          || !supplierCatalogue.some((entry) => entry.medicineId === catalogueSearchResults[next].id)) {
                          return next;
                        }
                      }
                      return current;
                    });
                  } else if (event.key === 'Enter' && catalogueDropdownOpen && activeCatalogueResult >= 0) {
                    event.preventDefault();
                    if (activeCatalogueResult < catalogueSearchResults.length) {
                      const medicine = catalogueSearchResults[activeCatalogueResult];
                      if (!supplierCatalogue.some((entry) => entry.medicineId === medicine.id)) {
                        handleAddCatalogueMedicine(medicine);
                      }
                    } else if (canCreate) {
                      openAddNewMedicine();
                    }
                  }
                }}
              />
              {catalogueDropdownOpen && debouncedCatalogueSearch && (
                <div className="pharmacy-catalogue-search__results" id="supplier-catalogue-search-results" role="listbox">
                  {catalogueLoading ? (
                    <div className="pharmacy-catalogue-search__empty" role="status">Loading medicines...</div>
                  ) : (
                    <>
                      {catalogueSearchResults.length === 0 && (
                        <div className="pharmacy-catalogue-search__empty">No medicine found</div>
                      )}
                      {catalogueSearchResults.map((medicine, index) => {
                        const alreadyAdded = supplierCatalogue.some((entry) => entry.medicineId === medicine.id);
                        return (
                          <button
                            type="button"
                            key={medicine.id}
                            id={`supplier-catalogue-option-${index}`}
                            className="pharmacy-catalogue-search__option"
                            role="option"
                            aria-selected={activeCatalogueResult === index}
                            disabled={alreadyAdded}
                            onMouseEnter={() => setActiveCatalogueResult(index)}
                            onClick={() => handleAddCatalogueMedicine(medicine)}
                          >
                            <span>
                              <strong>{medicine.name}</strong>
                              <small>{[medicine.genericName, medicine.strength, medicine.form].filter(Boolean).join(' · ')}</small>
                            </span>
                            <span className="pharmacy-catalogue-search__added">{alreadyAdded ? 'Added' : 'Add'}</span>
                          </button>
                        );
                      })}
                      {!hasExactMedicineName && (
                        <button
                          type="button"
                          id={`supplier-catalogue-option-${catalogueSearchResults.length}`}
                          className="pharmacy-catalogue-search__option pharmacy-catalogue-search__option--create"
                          role="option"
                          aria-selected={activeCatalogueResult === catalogueSearchResults.length}
                          onMouseEnter={() => setActiveCatalogueResult(catalogueSearchResults.length)}
                          onClick={openAddNewMedicine}
                        >
                          + Add new medicine '{catalogueSearch.trim()}'
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="pharmacy-supplier-catalogue-editor__count">
              {supplierCatalogue.length} {supplierCatalogue.length === 1 ? 'medicine' : 'medicines'}
            </div>
            {supplierCatalogue.length === 0 ? (
              <div className="pharmacy-supplier-catalogue-editor__empty">
                No medicines added yet. Search above to add medicines this supplier provides.
              </div>
            ) : (
              <div className="pharmacy-supplier-catalogue-editor__items">
                {supplierCatalogue.map((entry) => {
                  const medicine = catalogueMedicines.find((candidate) => candidate.id === entry.medicineId);
                  return (
                    <div className="pharmacy-supplier-catalogue-editor__row" key={entry.medicineId}>
                      <div className="pharmacy-supplier-catalogue-editor__medicine">
                        <strong>{medicine?.name || entry.medicineId}</strong>
                        <small>{[medicine?.genericName, medicine?.strength].filter(Boolean).join(' · ')}</small>
                      </div>
                      <FormField label="Fixed unit price (₹)">
                        <input
                          ref={(element) => { cataloguePriceRefs.current[entry.medicineId] = element; }}
                          type="text"
                          inputMode="decimal"
                          className="form-input"
                          value={entry.unitCost}
                          aria-invalid={Boolean(cataloguePriceErrors[entry.medicineId])}
                          onChange={(event) => {
                            const value = event.target.value;
                            setSupplierCatalogue((current) => current.map((item) => (
                              item.medicineId === entry.medicineId ? { ...item, unitCost: value } : item
                            )));
                            setCataloguePriceErrors((current) => ({
                              ...current,
                              [entry.medicineId]: supplierCataloguePriceError(value),
                            }));
                            setSupplierCatalogueError('');
                          }}
                        />
                        {cataloguePriceErrors[entry.medicineId] && (
                          <span className="pharmacy-form-error" role="alert">{cataloguePriceErrors[entry.medicineId]}</span>
                        )}
                      </FormField>
                      <button
                        type="button"
                        className="btn btn--ghost btn--icon pharmacy-supplier-catalogue-editor__remove"
                        aria-label={`Remove ${medicine?.name || entry.medicineId} from supplier catalogue`}
                        onClick={() => handleRemoveCatalogueMedicine(entry.medicineId)}
                      >
                        <Icon name="icon-x" size={16} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {supplierCatalogueError && <p className="pharmacy-form-error" role="alert">{supplierCatalogueError}</p>}
          </section>
        </div>
      </Modal>

      <Modal
        isOpen={newMedicineModalOpen}
        onClose={() => setNewMedicineModalOpen(false)}
        title="Add New Medicine"
        size="lg"
        footer={
          <>
            <button type="button" className="btn btn--secondary" onClick={() => setNewMedicineModalOpen(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn--primary" onClick={handleCreateMedicineForSupplier}>
              Create Medicine
            </button>
          </>
        }
      >
        <MedicineFormFields
          medForm={newMedicineForm}
          setMedForm={setNewMedicineForm}
          medicineFormErrors={newMedicineFormErrors}
          setMedicineFormErrors={setNewMedicineFormErrors}
        />
      </Modal>

      {/* Supplier Details / Typical Medicines Modal */}
      <Modal
        isOpen={ratesModalOpen}
        onClose={() => setRatesModalOpen(false)}
        title={`Supplier Profile — ${selectedSup?.name || ''}`}
        size="md"
        footer={<button type="button" className="btn btn--secondary" onClick={() => setRatesModalOpen(false)}>Close</button>}
      >
        {selectedSup && (
          <div>
            <p><strong>Code:</strong> {selectedSup.id}</p>
            <p><strong>Contact:</strong> {selectedSup.contactPerson} ({selectedSup.phone})</p>
            <p><strong>Email:</strong> {selectedSup.email}</p>
            <p><strong>Address:</strong> {selectedSup.address}</p>
            <h4 style={{ marginTop: '1.25rem', marginBottom: '0.5rem' }}>Contracted Medications</h4>
            {selectedSup.typicalMedicines?.length ? (
              <div className="pharmacy-supplier-catalogue-list">
                {selectedSup.typicalMedicines.map((entry, index) => {
                  const medicineId = typeof entry === 'string' ? entry : String(entry?.medicineId || entry?.id || '');
                  const medicine = catalogueMedicines.find((candidate) => candidate.id === medicineId);
                  const price = Number(typeof entry === 'object' && entry ? entry.fixedUnitPrice ?? entry.unitCost ?? entry.rate : 0);
                  return (
                    <div key={`${medicineId}-${index}`}>
                      <strong>{medicine?.name || entry?.name || medicineId}</strong>
                      <span>{price > 0 ? Format.money(price) : 'Price not set'}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-caption">No medicines are currently configured in this supplier catalogue.</p>
            )}
          </div>
        )}
      </Modal>
    </PharmacyPageWrapper>
  );
}

// =============================================================================
// 5. STOCK ALERTS PAGE
// =============================================================================

export function PharmacyAlertsPage() {
  const [filterTab, setFilterTab] = useState('ALL');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    const timeoutId = window.setTimeout(() => setDebouncedSearch(search.trim().toLowerCase()), 300);
    return () => window.clearTimeout(timeoutId);
  }, [search]);

  const { data: stockAlerts = {}, isLoading, error, refetch } = useQuery({
    queryKey: ['pharmacyStockAlertsAll'],
    queryFn: () => medicinesApi.stockAlerts(),
  });

  const allAlerts = useMemo(() => {
    const outList = (stockAlerts.outOfStock || []).map((m) => ({ ...m, type: 'OUT_OF_STOCK', typeLabel: 'Out of Stock', badgeVariant: 'danger' }));
    const lowList = (stockAlerts.lowStock || []).map((m) => ({ ...m, type: 'LOW_STOCK', typeLabel: 'Low Stock', badgeVariant: 'warning' }));
    const expList = (stockAlerts.expiring || []).map((m) => ({ ...m, type: 'EXPIRING', typeLabel: 'Expiring Soon', badgeVariant: 'warning' }));
    const expiredList = (stockAlerts.expired || []).map((m) => ({ ...m, type: 'EXPIRED', typeLabel: 'Expired Stock', badgeVariant: 'danger' }));
    return [...outList, ...lowList, ...expList, ...expiredList];
  }, [stockAlerts]);

  const filteredAlerts = useMemo(() => {
    return allAlerts.filter((item) => {
      const matchesTab = filterTab === 'ALL' || item.type === filterTab;
      const matchesSearch = !debouncedSearch || item.name?.toLowerCase().includes(debouncedSearch);
      return matchesTab && matchesSearch;
    });
  }, [allAlerts, filterTab, debouncedSearch]);

  return (
    <PharmacyPageWrapper>
      <div className="page-header">
        <div className="page-header__info">
          <h1 className="text-page-title">Stock Level & Expiry Alerts</h1>
          <p className="text-caption">Real-time alerts for out-of-stock items, replenishment thresholds, and impending batch expirations</p>
        </div>
        <div className="page-header__actions">
          <Link to="/pharmacy/purchases" className="btn btn--primary">
            <Icon name="icon-receipt" size={16} />
            <span>Create Purchase Order</span>
          </Link>
        </div>
      </div>

      <div className="glass card pharmacy-filter-panel" style={{ justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {[
            ['ALL', 'All'],
            ['OUT_OF_STOCK', 'Out of Stock'],
            ['LOW_STOCK', 'Low Stock'],
            ['EXPIRING', 'Expiring'],
            ['EXPIRED', 'Expired'],
          ].map(([tab, label]) => (
            <button
              key={tab}
              type="button"
              className={`btn btn--sm ${filterTab === tab ? 'btn--primary' : 'btn--secondary'}`}
              onClick={() => setFilterTab(tab)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="pharmacy-filter-panel__search" style={{ maxWidth: '280px' }}>
          <Icon name="icon-search" size={16} />
          <input
            type="text"
            className="form-input"
            placeholder="Search by medicine name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="glass card pharmacy-table-card">
        {isLoading ? (
          <PharmacyTableSkeleton columns={7} />
        ) : error ? (
          <ErrorState title="Unable to load stock alerts" error={error} onRetry={refetch} />
        ) : filteredAlerts.length === 0 ? (
          <EmptyState
            icon="icon-check-circle"
            title="No alerts found"
            message="No alerts match your search and selected filter."
          />
        ) : (
          <PharmacyDataTable
            className="pharmacy-data-table--alerts"
            minWidth="920px"
            columns={[
              { width: '22%' },
              { width: '13%' },
              { width: '14%', align: 'right' },
              { width: '15%', align: 'right' },
              { width: '13%' },
              { width: '12%', align: 'center' },
              { width: '11%', align: 'right' },
            ]}
          >
              <thead>
                <tr>
                  <th>Medicine</th>
                  <th>Batch</th>
                  <th>Current Stock</th>
                  <th>Reorder Threshold</th>
                  <th>Expiry Date</th>
                  <th>Alert Type</th>
                  <th style={{ textAlign: 'right' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredAlerts.map((item, idx) => (
                  <tr key={idx}>
                    <td style={{ fontWeight: 600 }}>{item.name}</td>
                    <td><code>{item.batchNo || '—'}</code></td>
                    <td><strong>{item.stockQuantity ?? 0} units</strong></td>
                    <td style={{ color: 'var(--muted, #64748b)' }}>{item.reorderThreshold ?? '—'} units</td>
                    <td>{item.expiryDate || '—'}</td>
                    <td>
                      <Badge variant={item.badgeVariant}>{item.typeLabel}</Badge>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <Link
                        to={`/pharmacy/inventory?restock=${encodeURIComponent(item.id)}`}
                        className="btn btn--secondary btn--sm"
                      >
                        Restock
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
          </PharmacyDataTable>
        )}
      </div>
    </PharmacyPageWrapper>
  );
}

// =============================================================================
// 6. DISPENSING & STOCK AUDIT HISTORY PAGE
// =============================================================================

export function PharmacyHistoryPage() {
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('ALL');

  const { data: ledger = [], isLoading, error, refetch } = useQuery({
    queryKey: ['stockLedgerHistory'],
    queryFn: async () => rowsFrom(await stockLedgerApi.list({ page_size: PAGE_SIZE })),
  });

  const filteredLedger = useMemo(() => {
    return ledger.filter((entry) => {
      const matchesType = typeFilter === 'ALL' || entry.entryType === typeFilter;
      const q = search.toLowerCase().trim();
      const matchesSearch =
        !q ||
        entry.medicineName?.toLowerCase().includes(q) ||
        entry.referenceId?.toLowerCase().includes(q) ||
        entry.batchNo?.toLowerCase().includes(q) ||
        entry.note?.toLowerCase().includes(q);
      return matchesType && matchesSearch;
    });
  }, [ledger, typeFilter, search]);

  return (
    <PharmacyPageWrapper>
      <div className="page-header">
        <div className="page-header__info">
          <h1 className="text-page-title">Dispensing & Movement Audit History</h1>
          <p className="text-caption">Chronological audit ledger of all pharmaceutical dispensing, receipts, and inventory adjustments</p>
        </div>
      </div>

      <div className="glass card pharmacy-filter-panel">
        <div className="pharmacy-filter-panel__search">
          <Icon name="icon-search" size={16} />
          <input
            type="text"
            className="form-input"
            placeholder="Search audit trail by medicine, reference ID, batch..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="pharmacy-filter-panel__select">
          <span>Movement Type:</span>
          <select className="form-input" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="ALL">All Movements</option>
            <option value="DISPENSE">Patient Dispense</option>
            <option value="RESTOCK">Stock Restock</option>
            <option value="PURCHASE">PO Goods Receipt</option>
          </select>
        </div>
      </div>

      <div className="glass card pharmacy-table-card">
        {isLoading ? (
          <PharmacyTableSkeleton columns={8} />
        ) : error ? (
          <ErrorState title="Unable to load stock history" error={error} onRetry={refetch} />
        ) : filteredLedger.length === 0 ? (
          <EmptyState
            icon="icon-history"
            title="No Movements Recorded"
            message="No stock ledger entries match your filter."
          />
        ) : (
          <PharmacyDataTable
            className="pharmacy-data-table--history"
            minWidth="1100px"
            columns={[
              { width: '12%' },
              { width: '18%' },
              { width: '12%', align: 'center' },
              { width: '10%', align: 'right' },
              { width: '12%' },
              { width: '12%' },
              { width: '10%' },
              { width: '14%' },
            ]}
          >
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Medication</th>
                  <th>Movement Type</th>
                  <th>Quantity</th>
                  <th>Batch</th>
                  <th>Reference ID</th>
                  <th>Staff</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {filteredLedger.map((entry, idx) => {
                  const qty = entry.quantity ?? 0;
                  const isPositive = qty > 0;
                  const badgeVariant =
                    entry.entryType === 'DISPENSE'
                      ? 'warning'
                      : entry.entryType === 'RESTOCK'
                      ? 'success'
                      : 'info';

                  return (
                    <tr key={entry.id || idx}>
                      <td>{formatDateTime(entry.createdAt)}</td>
                      <td><strong>{entry.medicineName || entry.medicineId}</strong></td>
                      <td><Badge variant={badgeVariant}>{entry.entryType}</Badge></td>
                      <td>
                        <strong style={{ color: isPositive ? 'var(--success, #10b981)' : 'var(--danger, #ef4444)' }}>
                          {isPositive ? `+${qty}` : qty} units
                        </strong>
                      </td>
                      <td><code>{entry.batchNo || '—'}</code></td>
                      <td>{entry.referenceId ? <code>{entry.referenceId}</code> : '—'}</td>
                      <td>{entry.performedBy || 'Dispensary Staff'}</td>
                      <td className="text-caption" style={{ maxWidth: '240px' }}>{formatDispenseNote(entry.note)}</td>
                    </tr>
                  );
                })}
              </tbody>
          </PharmacyDataTable>
        )}
      </div>
    </PharmacyPageWrapper>
  );
}
