"""Serializers for the administrator API."""

from decimal import Decimal
import math
import re

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from rest_framework import serializers

from cms_backendapp.models import AuditLog, Department, LabTestCatalog, Role, Setting, Staff, User
from cms_doctorapp.models import Doctor
from cms_labapp.models import LabTestResult
from cms_pharmapp.models import Supplier


SUPPORTED_ROLES = (
    ("ADMIN", "Administrator", "Clinic administrator"),
    ("DOCTOR", "Doctor", "Medical practitioner"),
    ("RECEPTIONIST", "Receptionist", "Front desk receptionist"),
    ("PHARMACIST", "Pharmacist", "Pharmacy operator"),
    ("LAB_TECH", "Lab Technician", "Laboratory technician"),
)


def ensure_supported_roles():
    """Create missing canonical role rows without duplicating existing roles."""
    with transaction.atomic():
        return [
            Role.objects.get_or_create(
                role_id=role_id,
                defaults={"role_name": name, "description": description},
            )[0]
            for role_id, name, description in SUPPORTED_ROLES
        ]


def validate_person_name(value):
    value = value.strip()
    if not re.fullmatch(r"[A-Za-z ]+", value) or len(re.sub(r"[^A-Za-z]", "", value)) < 3:
        raise serializers.ValidationError("Use at least 3 letters; only letters and spaces are allowed.")
    return value


def validate_gmail(value):
    value = value.strip()
    if value and not re.fullmatch(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@gmail\.com", value, re.IGNORECASE):
        raise serializers.ValidationError("Enter a valid @gmail.com email address.")
    return value or None


def validate_phone_number(value):
    value = value.strip()
    if value and not re.fullmatch(r"[0-9]{10}", value):
        raise serializers.ValidationError("Enter exactly 10 digits for the phone number.")
    return value or None


class PaiseField(serializers.DecimalField):
    """Expose DecimalField amounts as integer paise to match the React API."""

    def __init__(self, **kwargs):
        super().__init__(max_digits=10, decimal_places=2, min_value=0, **kwargs)

    def to_representation(self, value):
        return int((value * 100).quantize(Decimal("1")))

    def to_internal_value(self, data):
        try:
            data = Decimal(str(data)) / Decimal("100")
        except Exception as exc:
            raise serializers.ValidationError("Enter a valid amount in paise.") from exc
        return super().to_internal_value(data)


class DoctorProfileField(serializers.Field):
    """Read/write a doctor-only value through a Staff serializer."""

    def __init__(self, attribute, paise=False, **kwargs):
        self.attribute = attribute
        self.paise = paise
        kwargs.setdefault("required", False)
        kwargs.setdefault("allow_null", True)
        super().__init__(source="*", **kwargs)

    def get_attribute(self, instance):
        return instance

    def to_representation(self, staff):
        try:
            value = getattr(staff.doctor_profile, self.attribute)
        except Doctor.DoesNotExist:
            return None
        if self.paise and value is not None:
            return int((value * 100).quantize(Decimal("1")))
        return value

    def to_internal_value(self, data):
        if data is None or data == "":
            value = None
        elif self.paise:
            try:
                value = Decimal(str(data)) / Decimal("100")
            except Exception as exc:
                raise serializers.ValidationError("Enter a valid fee in paise.") from exc
        else:
            value = str(data).strip()
        return {self.attribute: value}


class AdminStaffSerializer(serializers.ModelSerializer):
    id = serializers.CharField(source="staff_id", read_only=True)
    departmentId = serializers.PrimaryKeyRelatedField(source="department", queryset=Department.objects.all(), required=False, allow_null=True, error_messages={"does_not_exist": "The selected department does not exist.", "incorrect_type": "Provide a valid department ID."})
    departmentName = serializers.CharField(source="department.name", read_only=True, allow_null=True)
    role = serializers.CharField(source="role.role_id", read_only=True, allow_null=True)
    roleId = serializers.CharField(write_only=True, required=False, allow_blank=True)
    username = serializers.CharField(write_only=True, required=False, max_length=50)
    password = serializers.CharField(write_only=True, required=False, trim_whitespace=False, style={"input_type": "password"})
    confirmPassword = serializers.CharField(write_only=True, required=False, trim_whitespace=False, style={"input_type": "password"})
    avatarUrl = serializers.CharField(source="avatar_url", required=False, allow_null=True, allow_blank=True)
    email = serializers.EmailField(required=False, allow_null=True, allow_blank=True)
    isActive = serializers.BooleanField(source="is_active", required=False)
    createdAt = serializers.DateTimeField(source="created_at", read_only=True)
    updatedAt = serializers.DateTimeField(source="updated_at", read_only=True)
    joinedAt = serializers.DateField(source="date_joined", read_only=True, allow_null=True)
    dateJoined = serializers.DateField(source="date_joined", write_only=True, required=False, allow_null=True)
    specialization = DoctorProfileField("specialization")
    qualification = DoctorProfileField("qualification")
    licenseNumber = DoctorProfileField("license_number")
    consultationFee = DoctorProfileField("consultation_fee", paise=True)

    class Meta:
        model = Staff
        fields = [
            "id", "name", "designation", "departmentId",
            "departmentName", "role", "roleId", "phone", "email", "avatarUrl",
            "dateJoined", "joinedAt", "isActive", "createdAt", "updatedAt",
            "specialization", "qualification", "licenseNumber", "consultationFee",
            "username", "password", "confirmPassword",
        ]

    def validate_roleId(self, value):
        if not value:
            return None
        ensure_supported_roles()
        try:
            return Role.objects.get(pk=value)
        except Role.DoesNotExist as exc:
            raise serializers.ValidationError("Unknown role.") from exc

    def validate_email(self, value):
        if self.instance and value == self.instance.email:
            return value
        value = validate_gmail(value or "")
        if value and Staff.objects.filter(email__iexact=value).exclude(pk=getattr(self.instance, "pk", None)).exists():
            raise serializers.ValidationError("A staff profile with this email already exists.")
        return value

    def validate_name(self, value):
        if self.instance and value.strip() == self.instance.name:
            return value.strip()
        return validate_person_name(value)

    def validate_phone(self, value):
        if self.instance and value == self.instance.phone:
            return value
        return validate_phone_number(value or "")

    def validate_username(self, value):
        value = value.strip()
        if not re.fullmatch(r"[A-Za-z0-9_.@+-]{1,50}", value):
            raise serializers.ValidationError("Use 1–50 letters, numbers, or . @ + - _ characters.")
        if User.objects.filter(username__iexact=value).exists():
            raise serializers.ValidationError("A user account with this username already exists.")
        return value

    def validate(self, attrs):
        role = attrs.get("roleId") or (self.instance.role if self.instance else None)
        role_id = getattr(role, "role_id", None)
        department = attrs.get("department", self.instance.department if self.instance else None)
        has_doctor_profile = bool(self.instance and Doctor.objects.filter(staff=self.instance).exists())
        for field in ("email", "phone"):
            if (self.instance is None and not attrs.get(field)) or (field in attrs and not attrs[field]):
                raise serializers.ValidationError({field: "This field is required."})
        if self.instance is None:
            required = [key for key in ("roleId", "username", "password", "confirmPassword") if not attrs.get(key)]
            if required:
                raise serializers.ValidationError({key: "This field is required when creating a staff login account." for key in required})
            if attrs["password"] != attrs["confirmPassword"]:
                raise serializers.ValidationError({"confirmPassword": "Passwords do not match."})
            django_user = get_user_model()(username=attrs["username"], email=attrs.get("email") or "")
            try:
                validate_password(attrs["password"], user=django_user)
            except DjangoValidationError as exc:
                raise serializers.ValidationError({"password": exc.messages}) from exc
        elif any(key in attrs for key in ("username", "password", "confirmPassword")):
            raise serializers.ValidationError({"username": "Login credentials can only be set when creating staff."})
        if role_id == "DOCTOR" and not has_doctor_profile:
            field_errors = {}
            for field, api_field in (("specialization", "specialization"), ("qualification", "qualification"), ("license_number", "licenseNumber"), ("consultation_fee", "consultationFee")):
                value = attrs.get(field)
                if value is None or value == "":
                    field_errors[api_field] = "This field is required for doctors."
            if not department:
                field_errors["departmentId"] = "Select a department for the doctor."
            if field_errors:
                raise serializers.ValidationError(field_errors)
        return attrs

    @transaction.atomic
    def create(self, validated_data):
        role = validated_data.pop("roleId", None)
        username = validated_data.pop("username")
        raw_password = validated_data.pop("password")
        validated_data.pop("confirmPassword", None)
        doctor_data = {key: validated_data.pop(key) for key in ("specialization", "qualification", "license_number", "consultation_fee") if key in validated_data}
        if role is not None:
            validated_data["role"] = role
        staff = super().create(validated_data)
        account = User(staff=staff, username=username, role=staff.role, is_active=staff.is_active)
        account.set_password(raw_password)
        account.save()
        if staff.role_id == "DOCTOR":
            doctor_data.setdefault("department", staff.department)
            doctor_data.setdefault("consultation_fee", staff.department.default_fee if staff.department else Decimal("0.00"))
            Doctor.objects.create(staff=staff, **doctor_data)
        return staff

    @transaction.atomic
    def update(self, instance, validated_data):
        role = validated_data.pop("roleId", serializers.empty)
        doctor_data = {key: validated_data.pop(key) for key in ("specialization", "qualification", "license_number", "consultation_fee") if key in validated_data}
        previous_department_id = instance.department_id
        if role is not serializers.empty:
            instance.role = role
        staff = super().update(instance, validated_data)
        if staff.role_id == "DOCTOR":
            profile = Doctor.objects.filter(staff=staff).first()
            if profile:
                if previous_department_id != staff.department_id:
                    doctor_data["department"] = staff.department
                if doctor_data:
                    for key, value in doctor_data.items():
                        setattr(profile, key, value)
                    profile.save()
            else:
                doctor_data.setdefault("department", staff.department)
                doctor_data.setdefault("consultation_fee", staff.department.default_fee if staff.department else Decimal("0.00"))
                Doctor.objects.create(staff=staff, **doctor_data)
        account = User.objects.filter(staff=staff).first()
        if account and staff.role_id and account.role_id != staff.role_id:
            account.role = staff.role
        if account and account.is_active != staff.is_active:
            account.is_active = staff.is_active
        if account:
            account.save(update_fields=["role", "is_active", "updated_at"])
        return staff


class AdminUserSerializer(serializers.ModelSerializer):
    id = serializers.CharField(source="user_id", read_only=True)
    staffId = serializers.PrimaryKeyRelatedField(source="staff", queryset=Staff.objects.all(), required=False)
    createStaff = serializers.BooleanField(write_only=True, required=False, default=False)
    newStaffName = serializers.CharField(write_only=True, required=False, allow_blank=True)
    designation = serializers.CharField(write_only=True, required=False, allow_blank=True)
    phone = serializers.CharField(write_only=True, required=False, allow_blank=True)
    email = serializers.EmailField(write_only=True, required=False, allow_null=True, allow_blank=True)
    departmentId = serializers.PrimaryKeyRelatedField(source="department", queryset=Department.objects.all(), write_only=True, required=False, allow_null=True, error_messages={"does_not_exist": "The selected department does not exist.", "incorrect_type": "Provide a valid department ID."})
    specialization = serializers.CharField(write_only=True, required=False, allow_blank=True)
    qualification = serializers.CharField(write_only=True, required=False, allow_blank=True)
    licenseNumber = serializers.CharField(write_only=True, required=False, allow_blank=True)
    consultationFee = PaiseField(write_only=True, required=False)
    staffName = serializers.CharField(source="staff.name", read_only=True)
    staffEmail = serializers.EmailField(source="staff.email", read_only=True, allow_null=True)
    role = serializers.CharField(source="role.role_id", read_only=True)
    roleId = serializers.CharField(write_only=True, required=False)
    isActive = serializers.BooleanField(source="is_active", required=False)
    failedAttempts = serializers.IntegerField(source="failed_attempts", read_only=True)
    lockedUntil = serializers.DateTimeField(source="locked_until", read_only=True, allow_null=True)
    lastLogin = serializers.DateTimeField(source="last_login", read_only=True, allow_null=True)
    password = serializers.CharField(write_only=True, required=False, min_length=8)
    confirmPassword = serializers.CharField(write_only=True, required=False, trim_whitespace=False)

    class Meta:
        model = User
        fields = [
            "id", "username", "password", "staffId", "staffName", "createStaff", "newStaffName",
            "role", "roleId", "isActive", "failedAttempts", "lockedUntil", "lastLogin", "staffEmail",
            "designation", "phone", "email", "departmentId", "specialization", "qualification",
            "licenseNumber", "consultationFee",
            "confirmPassword",
        ]

    def validate_username(self, value):
        value = value.strip()
        if not re.fullmatch(r"[A-Za-z0-9_.@+-]{1,50}", value):
            raise serializers.ValidationError("Use 1–50 letters, numbers, or . @ + - _ characters.")
        queryset = User.objects.filter(username__iexact=value)
        if self.instance:
            queryset = queryset.exclude(pk=self.instance.pk)
        if queryset.exists():
            raise serializers.ValidationError("A user account with this username already exists.")
        return value

    def validate(self, attrs):
        if "newStaffName" in attrs and attrs["newStaffName"]:
            attrs["newStaffName"] = validate_person_name(attrs["newStaffName"])
        if "email" in attrs and not (self.instance and attrs["email"] == self.instance.staff.email):
            attrs["email"] = validate_gmail(attrs["email"] or "")
        if "phone" in attrs and not (self.instance and attrs["phone"] == self.instance.staff.phone):
            attrs["phone"] = validate_phone_number(attrs["phone"] or "")
        if self.instance is None:
            if "password" not in attrs:
                raise serializers.ValidationError({"password": "This field is required."})
            if attrs.get("password") != attrs.get("confirmPassword"):
                raise serializers.ValidationError({"confirmPassword": "Passwords do not match."})
            if attrs.get("createStaff"):
                if not attrs.get("newStaffName"):
                    raise serializers.ValidationError({"newStaffName": "Enter the staff member's name."})
                for field in ("email", "phone"):
                    if not attrs.get(field):
                        raise serializers.ValidationError({field: "This field is required when creating a staff profile."})
                if attrs.get("email") and Staff.objects.filter(email__iexact=attrs["email"]).exists():
                    raise serializers.ValidationError({"email": "A staff profile with this email already exists."})
                if attrs.get("username") and User.objects.filter(username__iexact=attrs["username"].strip()).exists():
                    raise serializers.ValidationError({"username": "A user account with this username already exists."})
            elif "staff" not in attrs:
                raise serializers.ValidationError({"staffId": "This field is required."})
            elif User.objects.filter(staff=attrs["staff"]).exists():
                raise serializers.ValidationError({"staffId": "This staff member already has a login account."})
            if "roleId" not in attrs:
                raise serializers.ValidationError({"roleId": "This field is required."})
            role_id = attrs.get("roleId")
            if role_id == "DOCTOR" and attrs.get("createStaff"):
                doctor_required = ["department", "specialization", "qualification", "licenseNumber", "consultationFee"]
                missing = [field for field in doctor_required if attrs.get(field) is None or attrs.get(field) == ""]
                if missing:
                    raise serializers.ValidationError({field: "This field is required for doctor accounts." for field in missing})
            if "password" in attrs:
                from django.contrib.auth import get_user_model
                try:
                    validate_password(attrs["password"], user=get_user_model()(username=attrs.get("username", ""), email=attrs.get("email") or ""))
                except DjangoValidationError as exc:
                    raise serializers.ValidationError({"password": exc.messages}) from exc
        else:
            role_id = attrs.get("roleId", self.instance.role_id)
            if "password" in attrs:
                if attrs.get("password") != attrs.get("confirmPassword"):
                    raise serializers.ValidationError({"confirmPassword": "Passwords do not match."})
                from django.contrib.auth import get_user_model
                try:
                    validate_password(attrs["password"], user=get_user_model()(username=attrs.get("username", self.instance.username), email=self.instance.staff.email or ""))
                except DjangoValidationError as exc:
                    raise serializers.ValidationError({"password": exc.messages}) from exc
        if role_id == "DOCTOR" and not attrs.get("createStaff"):
            staff = attrs.get("staff", self.instance.staff if self.instance else None)
            if not staff or staff.role_id != "DOCTOR" or not Doctor.objects.filter(staff=staff).exists():
                raise serializers.ValidationError({"staffId": "Select a doctor with a complete doctor profile or create a doctor staff profile first."})
        return attrs

    def _take_related(self, validated_data):
        role_id = validated_data.pop("roleId", None)
        if role_id is not None:
            ensure_supported_roles()
            try:
                validated_data["role"] = Role.objects.get(pk=role_id)
            except Role.DoesNotExist as exc:
                raise serializers.ValidationError({"roleId": "Unknown role."}) from exc

    @transaction.atomic
    def create(self, validated_data):
        password = validated_data.pop("password")
        validated_data.pop("confirmPassword", None)
        create_staff = validated_data.pop("createStaff", False)
        staff_name = validated_data.pop("newStaffName", None)
        designation = validated_data.pop("designation", "")
        phone = validated_data.pop("phone", "")
        email = validated_data.pop("email", None) or None
        department = validated_data.pop("department", None)
        doctor_data = {
            "specialization": validated_data.pop("specialization", ""),
            "qualification": validated_data.pop("qualification", ""),
            "license_number": validated_data.pop("licenseNumber", ""),
            "consultation_fee": validated_data.pop("consultationFee", None),
        }
        self._take_related(validated_data)
        if create_staff:
            role = validated_data.get("role")
            staff = Staff.objects.create(
                name=staff_name.strip(), designation=designation.strip() or None,
                phone=phone.strip() or None, email=email, role=role, department=department,
                is_active=True,
            )
            validated_data["staff"] = staff
            if role.role_id == "DOCTOR":
                doctor_data["department"] = department
                if doctor_data["consultation_fee"] is None:
                    doctor_data["consultation_fee"] = department.default_fee
                Doctor.objects.create(staff=staff, **doctor_data)
        else:
            staff = validated_data.get("staff")
            role = validated_data.get("role")
            if staff and role and staff.role_id != role.role_id:
                staff.role = role
                staff.save(update_fields=["role", "updated_at"])
        user = User(**validated_data)
        user.set_password(password)
        user.save()
        if user.staff.role_id != user.role_id:
            user.staff.role = user.role
            user.staff.save(update_fields=["role", "updated_at"])
        return user

    @transaction.atomic
    def update(self, instance, validated_data):
        password = validated_data.pop("password", None)
        validated_data.pop("confirmPassword", None)
        self._take_related(validated_data)
        for field in (
            "createStaff", "newStaffName", "designation", "phone", "email", "department",
            "specialization", "qualification", "licenseNumber", "consultationFee",
        ):
            validated_data.pop(field, None)
        user = super().update(instance, validated_data)
        if password:
            user.set_password(password)
            user.failed_attempts = 0
            user.locked_until = None
            user.save(update_fields=["password_hash", "failed_attempts", "locked_until"])
        if user.staff.role_id != user.role_id:
            user.staff.role = user.role
            user.staff.save(update_fields=["role", "updated_at"])
        return user


class AdminDepartmentSerializer(serializers.ModelSerializer):
    id = serializers.CharField(source="department_id", read_only=True)
    headDoctorId = serializers.CharField(source="head_doctor.staff_id", read_only=True, allow_null=True)
    headDoctorName = serializers.CharField(source="head_doctor.name", read_only=True, allow_null=True)
    headDoctorIdInput = serializers.CharField(write_only=True, required=False, allow_blank=True)
    defaultFee = PaiseField(source="default_fee", required=False)
    code = serializers.CharField(required=False, allow_null=True, allow_blank=True)
    isBookable = serializers.BooleanField(source="is_bookable", required=False)
    isActive = serializers.BooleanField(source="is_active", required=False)
    createdAt = serializers.DateTimeField(source="created_at", read_only=True)
    updatedAt = serializers.DateTimeField(source="updated_at", read_only=True)

    class Meta:
        model = Department
        fields = [
            "id", "name", "code", "headDoctorId", "headDoctorName", "headDoctorIdInput",
            "defaultFee", "isBookable", "description", "isActive", "createdAt", "updatedAt",
        ]

    def to_internal_value(self, data):
        result = super().to_internal_value(data)
        result.pop("headDoctorIdInput", None)
        head_id = data.get("headDoctorIdInput", serializers.empty)
        if head_id is not serializers.empty:
            if not head_id:
                result["head_doctor"] = None
            else:
                try:
                    result["head_doctor"] = Staff.objects.get(pk=head_id, role__role_id="DOCTOR")
                except Staff.DoesNotExist as exc:
                    raise serializers.ValidationError({"headDoctorIdInput": "Choose an existing doctor."}) from exc
        return result

    def validate_code(self, value):
        return value or None


class AdminLabCatalogSerializer(serializers.ModelSerializer):
    id = serializers.CharField(source="test_catalog_id", read_only=True)
    name = serializers.CharField(source="test_name", min_length=2, max_length=100)
    testName = serializers.CharField(source="test_name", read_only=True)
    sampleType = serializers.CharField(source="sample_type", required=False, allow_null=True, allow_blank=True, max_length=50)
    turnaroundHrs = serializers.IntegerField(source="turnaround_hrs", required=True, min_value=1, max_value=720)
    price = PaiseField(required=False)
    code = serializers.CharField(required=True, allow_blank=False, max_length=20)
    category = serializers.CharField(required=False, allow_null=True, allow_blank=True, max_length=50)
    description = serializers.CharField(required=False, allow_null=True, allow_blank=True)
    parameters = serializers.JSONField(required=True)
    isActive = serializers.BooleanField(source="is_active", required=False)
    departmentId = serializers.PrimaryKeyRelatedField(source="department", queryset=Department.objects.all(), required=False, allow_null=True)

    class Meta:
        model = LabTestCatalog
        fields = [
            "id", "name", "testName", "code", "category", "sampleType", "parameters",
            "turnaroundHrs", "description", "price", "isActive", "departmentId",
        ]

    def validate_name(self, value):
        value = value.strip()
        if len(value) < 2:
            raise serializers.ValidationError("Test name must be at least 2 characters.")
        duplicate = LabTestCatalog.objects.filter(test_name__iexact=value)
        if self.instance:
            duplicate = duplicate.exclude(pk=self.instance.pk)
        if duplicate.exists():
            raise serializers.ValidationError("A lab test with this name already exists.")
        return value

    def validate_code(self, value):
        value = value.strip().upper()
        if not re.fullmatch(r"[A-Z0-9_-]+", value):
            raise serializers.ValidationError("Use uppercase letters, numbers, hyphens, or underscores with no spaces.")
        duplicate = LabTestCatalog.objects.filter(code__iexact=value)
        if self.instance:
            duplicate = duplicate.exclude(pk=self.instance.pk)
        if duplicate.exists():
            raise serializers.ValidationError("Test code already exists.")
        return value

    def validate_category(self, value):
        return value.strip() if isinstance(value, str) else value

    def validate_sampleType(self, value):
        return value.strip() if isinstance(value, str) else value

    def validate_turnaroundHrs(self, value):
        if value > 720:
            raise serializers.ValidationError("Turnaround time cannot exceed 720 hours.")
        return value

    def validate(self, attrs):
        name = attrs.get("test_name", getattr(self.instance, "test_name", ""))
        category = attrs.get("category", getattr(self.instance, "category", ""))
        duplicates = LabTestCatalog.objects.filter(test_name__iexact=name)
        if category:
            duplicates = duplicates.filter(category__iexact=category)
        if self.instance:
            duplicates = duplicates.exclude(pk=self.instance.pk)
        if duplicates.exists():
            raise serializers.ValidationError({"name": "A test with this name already exists in this category."})
        return attrs

    def validate_parameters(self, value):
        if not isinstance(value, list):
            raise serializers.ValidationError("Parameters must be a JSON array.")
        if self.instance is None and not value:
            raise serializers.ValidationError("At least one test parameter is required.")
        names = set()
        indexed_errors = [{} for _ in value]
        normalized = []
        for index, parameter in enumerate(value):
            if not isinstance(parameter, dict) or not isinstance(parameter.get("name"), str) or not parameter["name"].strip():
                indexed_errors[index]["name"] = "Parameter name is required."
                normalized.append(parameter)
                continue
            name = parameter["name"].strip()
            parameter = {**parameter, "name": name}
            unit = parameter.get("unit")
            if unit is not None and not isinstance(unit, str):
                indexed_errors[index]["unit"] = "Unit must be text."
            elif isinstance(unit, str):
                parameter["unit"] = unit.strip()
                if len(unit.strip()) > 30:
                    indexed_errors[index]["unit"] = "Unit cannot exceed 30 characters."
            if name.casefold() in names:
                indexed_errors[index]["name"] = "Parameter names must be unique within this test."
            names.add(name.casefold())
            parsed_bounds = {}
            for key in ("refMin", "refMax", "criticalMin", "criticalMax"):
                bound = parameter.get(key)
                if bound is None:
                    parsed_bounds[key] = None
                    continue
                if isinstance(bound, bool):
                    indexed_errors[index][key] = "Enter a valid non-negative number."
                    parsed_bounds[key] = None
                    continue
                try:
                    numeric_bound = float(bound)
                    if not math.isfinite(numeric_bound) or numeric_bound < 0:
                        raise ValueError
                except (TypeError, ValueError) as exc:
                    indexed_errors[index][key] = "Enter a valid non-negative number."
                    parsed_bounds[key] = None
                    continue
                parsed_bounds[key] = numeric_bound
                parameter[key] = numeric_bound
            ref_min = parsed_bounds.get("refMin")
            ref_max = parsed_bounds.get("refMax")
            critical_min = parsed_bounds.get("criticalMin")
            critical_max = parsed_bounds.get("criticalMax")
            if ref_min is not None and ref_max is not None and ref_min >= ref_max:
                indexed_errors[index]["refMax"] = "Reference maximum must be greater than the minimum."
            if critical_min is not None and (ref_min is None or critical_min > ref_min):
                indexed_errors[index]["criticalMin"] = "Critical low must be less than or equal to the reference minimum."
            if critical_max is not None and (ref_max is None or critical_max < ref_max):
                indexed_errors[index]["criticalMax"] = "Critical high must be greater than or equal to the reference maximum."
            normalized.append(parameter)

        if any(indexed_errors):
            raise serializers.ValidationError(indexed_errors)

        if self.instance:
            saved_names = {}
            for results in LabTestResult.objects.filter(
                test__test_catalog_id=self.instance.pk
            ).values_list("results", flat=True):
                if isinstance(results, list):
                    for row in results:
                        if isinstance(row, dict) and row.get("parameter"):
                            saved_name = str(row["parameter"])
                            saved_names[saved_name.casefold()] = saved_name
                elif isinstance(results, dict):
                    saved_names.update({str(name).casefold(): str(name) for name in results})
            next_names = {item["name"].casefold() for item in normalized if isinstance(item, dict)}
            removed = set(saved_names) - next_names
            if removed:
                removed_name = saved_names[sorted(removed)[0]]
                raise serializers.ValidationError({
                    "parameters": f"Cannot remove or rename '{removed_name}' because saved lab results use it."
                })
        return normalized


class AdminSupplierSerializer(serializers.ModelSerializer):
    id = serializers.CharField(source="supplier_id", read_only=True)
    contactPerson = serializers.CharField(source="contact_person", required=False, allow_null=True, allow_blank=True)
    typicalMedicines = serializers.JSONField(source="typical_medicines", required=False)
    isActive = serializers.BooleanField(source="is_active", required=False)

    class Meta:
        model = Supplier
        fields = ["id", "name", "contactPerson", "phone", "email", "address", "typicalMedicines", "isActive"]

    def validate_name(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError("Supplier name is required.")
        return value

    def validate_typicalMedicines(self, value):
        if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
            raise serializers.ValidationError("Medicine references must be a JSON array of names.")
        return [item.strip() for item in value if item.strip()]


class AdminSettingSerializer(serializers.ModelSerializer):
    id = serializers.CharField(source="setting_id", read_only=True)

    class Meta:
        model = Setting
        fields = ["id", "key", "value", "updated_at"]
        read_only_fields = ["id", "updated_at"]


class AdminAuditLogSerializer(serializers.ModelSerializer):
    id = serializers.CharField(source="log_id", read_only=True)
    userId = serializers.CharField(source="user.user_id", read_only=True, allow_null=True)
    userName = serializers.CharField(source="user.username", read_only=True, allow_null=True)
    resourceType = serializers.CharField(source="entity_type", read_only=True)
    resourceId = serializers.CharField(source="entity_id", read_only=True)
    ipAddress = serializers.CharField(source="ip_address", read_only=True, allow_null=True)
    createdAt = serializers.DateTimeField(source="created_at", read_only=True)

    class Meta:
        model = AuditLog
        fields = ["id", "userId", "userName", "action", "resourceType", "resourceId", "details", "ipAddress", "createdAt"]
