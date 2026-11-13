import React, { useState } from 'react';
import { FormField } from '../../components/ui';

const emptyParameter = () => ({ name: '', unit: '', refMin: '', refMax: '', criticalMin: '', criticalMax: '' });

function parameterFormValue(parameter) {
  const {
    min, max, criticalLow, criticalHigh,
    ...metadata
  } = parameter || {};
  return {
    ...metadata,
    name: String(parameter?.name || ''),
    unit: String(parameter?.unit || ''),
    refMin: String(parameter?.refMin ?? min ?? ''),
    refMax: String(parameter?.refMax ?? max ?? ''),
    criticalMin: String(parameter?.criticalMin ?? criticalLow ?? ''),
    criticalMax: String(parameter?.criticalMax ?? criticalHigh ?? ''),
  };
}

function formValue(test) {
  return {
    name: test?.name || '',
    code: test?.code || '',
    category: test?.category || '',
    sampleType: test?.sampleType || '',
    turnaroundHrs: String(test?.turnaroundHrs ?? 4),
    description: test?.description || '',
    priceRupees: (Number(test?.price || 0) / 100).toFixed(2),
    parameters: Array.isArray(test?.parameters) && test.parameters.length
      ? test.parameters.map(parameterFormValue)
      : [emptyParameter()],
    isActive: test?.isActive ?? true,
  };
}

function parseBound(value, label, errors, key) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const number = Number(raw);
  if (!Number.isFinite(number) || number < 0) {
    errors[key] = `${label} must be a valid non-negative number.`;
    return null;
  }
  return number;
}

export default function LabTestCreateForm({
  initialValues,
  existingTests = [],
  mode = 'create',
  onSubmit,
  onCancel,
  onClearServerErrors,
  isPending,
  error,
  fieldErrors = {},
}) {
  const [form, setForm] = useState(() => formValue(initialValues));
  const [validationErrors, setValidationErrors] = useState({});
  const errors = { ...fieldErrors, ...validationErrors };

  const updateField = (key, value) => {
    setForm((current) => ({ ...current, [key]: value }));
    setValidationErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    onClearServerErrors?.();
  };

  const updateParameter = (index, key, value) => {
    setForm((current) => ({
      ...current,
      parameters: current.parameters.map((parameter, itemIndex) => (
        itemIndex === index ? { ...parameter, [key]: value } : parameter
      )),
    }));
    setValidationErrors((current) => {
      const next = { ...current };
      delete next[`parameters.${index}.${key}`];
      delete next.parameters;
      return next;
    });
    onClearServerErrors?.();
  };

  const inputProps = (key) => ({
    'aria-invalid': Boolean(errors[key]),
    style: errors[key] ? { borderColor: 'var(--danger)' } : undefined,
  });

  const submit = (event) => {
    event.preventDefault();
    const nextErrors = {};
    const name = form.name.trim();
    const code = form.code.trim().toUpperCase();
    const category = form.category.trim();
    const sampleType = form.sampleType.trim();
    const turnaroundHrs = Number(form.turnaroundHrs);
    const priceRupees = Number(form.priceRupees);

    if (name.length < 2 || name.length > 100) nextErrors.name = 'Test name must be 2 to 100 characters.';
    if (!code) nextErrors.code = 'Test code is required.';
    else if (!/^[A-Z0-9_-]+$/.test(code)) nextErrors.code = 'Use uppercase letters, numbers, hyphens, or underscores with no spaces.';
    else if (existingTests.some((test) => test.id !== initialValues?.id && String(test.code || '').toUpperCase() === code)) {
      nextErrors.code = 'Test code already exists.';
    }
    if (category.length > 50) nextErrors.category = 'Category cannot exceed 50 characters.';
    if (sampleType.length > 50) nextErrors.sampleType = 'Sample type cannot exceed 50 characters.';
    if (existingTests.some((test) => test.id !== initialValues?.id
      && String(test.name || '').trim().toLowerCase() === name.toLowerCase()
      && String(test.category || '').trim().toLowerCase() === category.toLowerCase())) {
      nextErrors.name = 'A test with this name already exists in this category.';
    }
    if (!Number.isInteger(turnaroundHrs) || turnaroundHrs < 1 || turnaroundHrs > 720) {
      nextErrors.turnaroundHrs = 'Turnaround time must be a whole number from 1 to 720 hours.';
    }
    if (!Number.isFinite(priceRupees) || priceRupees < 0 || !/^\d+(\.\d{1,2})?$/.test(form.priceRupees)) {
      nextErrors.price = 'Enter a valid non-negative price with at most two decimal places.';
    }
    if (!form.parameters.length) nextErrors.parameters = 'At least one parameter is required.';

    const parameterNames = form.parameters.map((parameter) => parameter.name.trim().toLowerCase());
    if (new Set(parameterNames.filter(Boolean)).size !== parameterNames.filter(Boolean).length) {
      form.parameters.forEach((parameter, index) => {
        if (parameter.name.trim() && parameterNames.indexOf(parameterNames[index]) !== index) {
          nextErrors[`parameters.${index}.name`] = 'Parameter names must be unique within this test.';
        }
      });
    }

    const parameters = form.parameters.map((parameter, index) => {
      const prefix = `parameters.${index}.`;
      const parameterName = parameter.name.trim();
      if (!parameterName) nextErrors[`${prefix}name`] = 'Parameter name is required.';
      if (parameter.unit.trim().length > 30) nextErrors[`${prefix}unit`] = 'Unit cannot exceed 30 characters.';
      const refMin = parseBound(parameter.refMin, 'Reference minimum', nextErrors, `${prefix}refMin`);
      const refMax = parseBound(parameter.refMax, 'Reference maximum', nextErrors, `${prefix}refMax`);
      const criticalMin = parseBound(parameter.criticalMin, 'Critical low', nextErrors, `${prefix}criticalMin`);
      const criticalMax = parseBound(parameter.criticalMax, 'Critical high', nextErrors, `${prefix}criticalMax`);
      if (refMin != null && refMax != null && refMin >= refMax) {
        nextErrors[`${prefix}refMax`] = 'Reference maximum must be greater than the minimum.';
      }
      if (criticalMin != null && (refMin == null || criticalMin > refMin)) {
        nextErrors[`${prefix}criticalMin`] = 'Critical low must be less than or equal to the reference minimum.';
      }
      if (criticalMax != null && (refMax == null || criticalMax < refMax)) {
        nextErrors[`${prefix}criticalMax`] = 'Critical high must be greater than or equal to the reference maximum.';
      }
      return {
        ...parameter,
        name: parameterName,
        unit: parameter.unit.trim(),
        dataType: parameter.dataType || 'number',
        required: parameter.required ?? true,
        refMin,
        refMax,
        criticalMin,
        criticalMax,
      };
    });

    if (Object.keys(nextErrors).length) {
      setValidationErrors(nextErrors);
      return;
    }

    setValidationErrors({});
    onClearServerErrors?.();
    onSubmit({
      name,
      code,
      category,
      sampleType,
      turnaroundHrs,
      description: form.description.trim(),
      price: Math.round(priceRupees * 100),
      parameters,
      isActive: form.isActive,
    });
  };

  return (
    <form className="lab-catalog-form" onSubmit={submit} noValidate>
      <p className="lab-catalog-form__intro">Enter the test details and reporting ranges used to interpret results.</p>
      {error && <p className="lab-catalog-form__error" role="alert">{error}</p>}
      <section className="lab-catalog-form__section" aria-labelledby="admin-lab-test-details-heading">
        <div className="lab-catalog-form__section-heading">
          <span className="lab-catalog-form__step">1</span>
          <div><h3 id="admin-lab-test-details-heading">Test details</h3><p>Basic identification and specimen information</p></div>
        </div>
        <div className="lab-catalog-form__grid">
          <FormField label="Test name" required error={errors.name}><input className="form-input" maxLength={100} placeholder="e.g. Serum calcium" value={form.name} onChange={(event) => updateField('name', event.target.value)} required {...inputProps('name')} /></FormField>
          <FormField label="Test code" required error={errors.code}><input className="form-input" maxLength={20} placeholder="e.g. CA" value={form.code} onChange={(event) => updateField('code', event.target.value.toUpperCase())} required {...inputProps('code')} /></FormField>
          <FormField label="Category" error={errors.category}><input className="form-input" maxLength={50} placeholder="e.g. Biochemistry" value={form.category} onChange={(event) => updateField('category', event.target.value)} {...inputProps('category')} /></FormField>
          <FormField label="Sample type" error={errors.sampleType}><input className="form-input" maxLength={50} placeholder="e.g. Serum" value={form.sampleType} onChange={(event) => updateField('sampleType', event.target.value)} {...inputProps('sampleType')} /></FormField>
          <FormField label="Turnaround time (hours)" required error={errors.turnaroundHrs}><input className="form-input" type="number" min="1" max="720" step="1" value={form.turnaroundHrs} onChange={(event) => updateField('turnaroundHrs', event.target.value)} required {...inputProps('turnaroundHrs')} /></FormField>
          <FormField label="Billing price (₹)" required error={errors.price} hint="New tests default to ₹0."><input className="form-input" type="number" min="0" step="0.01" value={form.priceRupees} onChange={(event) => updateField('priceRupees', event.target.value)} required {...inputProps('price')} /></FormField>
          <FormField label="Description"><input className="form-input" placeholder="Optional clinical or processing notes" value={form.description} onChange={(event) => updateField('description', event.target.value)} /></FormField>
          <label className="form-check"><input type="checkbox" checked={form.isActive} onChange={(event) => updateField('isActive', event.target.checked)} /> Active</label>
        </div>
      </section>
      <section className="lab-catalog-form__section" aria-labelledby="admin-lab-parameters-heading">
        <div className="lab-catalog-form__section-heading">
          <span className="lab-catalog-form__step">2</span>
          <div><h3 id="admin-lab-parameters-heading">Parameters &amp; reference ranges</h3><p>Set units and normal or critical limits for reported values</p></div>
        </div>
        {errors.parameters && <p className="lab-catalog-form__error" role="alert">{errors.parameters}</p>}
        <div className="lab-catalog-form__parameters">
          {form.parameters.map((parameter, index) => (
            <section key={`parameter-${index}`} className="lab-catalog-form__parameter">
              <div className="lab-catalog-form__parameter-heading">
                <strong>Parameter {String(index + 1).padStart(2, '0')}</strong>
                {form.parameters.length > 1 && <button type="button" className="btn btn--ghost btn--sm" onClick={() => { setForm((current) => ({ ...current, parameters: current.parameters.filter((_, itemIndex) => itemIndex !== index) })); onClearServerErrors?.(); }}>Remove</button>}
              </div>
              <div className="lab-catalog-form__grid lab-catalog-form__grid--parameters">
                <FormField label="Parameter name" required error={errors[`parameters.${index}.name`]}><input className="form-input" maxLength={100} placeholder="e.g. Calcium" value={parameter.name} onChange={(event) => updateParameter(index, 'name', event.target.value)} required {...inputProps(`parameters.${index}.name`)} /></FormField>
                <FormField label="Unit" error={errors[`parameters.${index}.unit`]}><input className="form-input" maxLength={30} placeholder="e.g. mg/dL" value={parameter.unit} onChange={(event) => updateParameter(index, 'unit', event.target.value)} {...inputProps(`parameters.${index}.unit`)} /></FormField>
                {[
                  ['refMin', 'Reference minimum', 'No lower limit'],
                  ['refMax', 'Reference maximum', 'No upper limit'],
                  ['criticalMin', 'Critical low', 'Optional'],
                  ['criticalMax', 'Critical high', 'Optional'],
                ].map(([key, label, placeholder]) => {
                  const errorKey = `parameters.${index}.${key}`;
                  return <FormField key={key} label={label} error={errors[errorKey]}><input className="form-input" type="number" min="0" step="any" placeholder={placeholder} value={parameter[key]} onChange={(event) => updateParameter(index, key, event.target.value)} {...inputProps(errorKey)} /></FormField>;
                })}
              </div>
            </section>
          ))}
        </div>
        <button type="button" className="btn btn--secondary btn--sm" onClick={() => { setForm((current) => ({ ...current, parameters: [...current.parameters, emptyParameter()] })); onClearServerErrors?.(); }}>+ Add parameter</button>
      </section>
      <div className="lab-catalog-form__actions">
        <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={isPending}>Cancel</button>
        <button type="submit" className="btn btn--primary" disabled={isPending}>{isPending ? 'Saving…' : mode === 'edit' ? 'Save Changes' : 'Add Test'}</button>
      </div>
    </form>
  );
}
