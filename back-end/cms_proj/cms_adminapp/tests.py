"""Focused regression coverage for admin staff creation and management."""

from datetime import date

from rest_framework.test import APITestCase

from cms_backendapp.models import Department, LabTestCatalog, Role, Staff, User
from cms_doctorapp.models import Doctor, LabTest
from cms_labapp.models import LabTestResult
from cms_pharmapp.models import Supplier
from cms_recepapp.models import Patient


class AdminStaffFlowTests(APITestCase):
    password = "BlueForest!5931"

    def setUp(self):
        self.admin_role = Role.objects.create(role_id="ADMIN", role_name="Administrator")
        self.admin_staff = Staff.objects.create(name="Admin Account", role=self.admin_role)
        self.admin = User(staff=self.admin_staff, username="admin.test", role=self.admin_role)
        self.admin.set_password(self.password)
        self.admin.save()
        self.client.force_authenticate(user=self.admin)
        self.department = Department.objects.create(name="Cardiology", code="CARD")

    def staff_payload(self, role="RECEPTIONIST", suffix="one", **overrides):
        payload = {
            "name": "Test Person",
            "email": f"{suffix}@gmail.com",
            "phone": "9876543210",
            "roleId": role,
            "departmentId": self.department.pk if role == "DOCTOR" else None,
            "username": f"staff.{suffix}",
            "password": self.password,
            "confirmPassword": self.password,
        }
        if role == "DOCTOR":
            payload.update({
                "specialization": "Cardiology",
                "qualification": "MBBS, MD",
                "licenseNumber": f"LIC-{suffix}",
                "consultationFee": 55000,
            })
        payload.update(overrides)
        return payload

    def test_supported_roles_are_synced_and_staff_accounts_created(self):
        response = self.client.get("/api/admin/roles/")
        self.assertEqual(response.status_code, 200)
        roles = {row["code"] for row in response.data}
        self.assertEqual(roles, {"ADMIN", "DOCTOR", "RECEPTIONIST", "PHARMACIST", "LAB_TECH"})

        for index, role in enumerate(sorted(roles)):
            response = self.client.post("/api/admin/staff/", self.staff_payload(role, f"person{index}"), format="json")
            self.assertEqual(response.status_code, 201, response.data)
            staff = Staff.objects.get(pk=response.data["id"])
            account = User.objects.get(staff=staff)
            self.assertEqual(staff.role_id, role)
            self.assertEqual(account.role_id, role)
            self.assertTrue(account.check_password(self.password))
            self.assertNotIn("password", response.data)

        doctor = Staff.objects.get(role__role_id="DOCTOR")
        self.assertEqual(doctor.doctor_profile.department_id, self.department.pk)

    def test_invalid_role_department_duplicate_and_password_are_rejected(self):
        unsupported = self.client.post("/api/admin/staff/", self.staff_payload("UNSUPPORTED", "unsupported"), format="json")
        self.assertEqual(unsupported.status_code, 400)
        self.assertIn("roleId", unsupported.data)

        invalid_department = self.client.post("/api/admin/staff/", self.staff_payload("DOCTOR", "baddept", departmentId="missing"), format="json")
        self.assertEqual(invalid_department.status_code, 400)
        self.assertIn("departmentId", invalid_department.data)

        mismatch = self.client.post("/api/admin/staff/", self.staff_payload("RECEPTIONIST", "mismatch", confirmPassword="Wrong!Password222"), format="json")
        self.assertEqual(mismatch.status_code, 400)
        self.assertIn("confirmPassword", mismatch.data)

        weak = self.client.post("/api/admin/staff/", self.staff_payload("RECEPTIONIST", "weak", password="12345678", confirmPassword="12345678"), format="json")
        self.assertEqual(weak.status_code, 400)
        self.assertIn("password", weak.data)

        first = self.client.post("/api/admin/staff/", self.staff_payload("RECEPTIONIST", "duplicate"), format="json")
        self.assertEqual(first.status_code, 201, first.data)
        duplicate = self.client.post("/api/admin/staff/", self.staff_payload("RECEPTIONIST", "duplicate2", username="staff.duplicate"), format="json")
        self.assertEqual(duplicate.status_code, 400)
        self.assertIn("username", duplicate.data)

        duplicate_email = self.client.post("/api/admin/staff/", self.staff_payload("RECEPTIONIST", "duplicate3", email="duplicate@gmail.com"), format="json")
        self.assertEqual(duplicate_email.status_code, 400)
        self.assertIn("email", duplicate_email.data)

    def test_name_email_phone_required_and_validated(self):
        invalid_name = self.client.post("/api/admin/staff/", self.staff_payload(name="Jo", suffix="short"), format="json")
        self.assertEqual(invalid_name.status_code, 400)
        self.assertIn("name", invalid_name.data)

        invalid_email = self.client.post("/api/admin/staff/", self.staff_payload("RECEPTIONIST", "bademail", email="person@example.com"), format="json")
        self.assertEqual(invalid_email.status_code, 400)
        self.assertIn("email", invalid_email.data)

        invalid_phone = self.client.post("/api/admin/staff/", self.staff_payload("RECEPTIONIST", "badphone", phone="12345abcde"), format="json")
        self.assertEqual(invalid_phone.status_code, 400)
        self.assertIn("phone", invalid_phone.data)

        missing_email = self.client.post("/api/admin/staff/", self.staff_payload("RECEPTIONIST", "missingemail", email=""), format="json")
        self.assertEqual(missing_email.status_code, 400)
        self.assertIn("email", missing_email.data)

        missing_phone = self.client.post("/api/admin/staff/", self.staff_payload("RECEPTIONIST", "missingphone", phone=""), format="json")
        self.assertEqual(missing_phone.status_code, 400)
        self.assertIn("phone", missing_phone.data)

    def test_search_case_insensitive_clear_and_status_action(self):
        created = self.client.post("/api/admin/staff/", self.staff_payload("RECEPTIONIST", "searchable"), format="json")
        self.assertEqual(created.status_code, 201, created.data)
        result = self.client.get("/api/admin/staff/?search=SEARCHABLE%40GMAIL.COM")
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.data["count"], 1)
        self.assertEqual(result.data["results"][0]["email"], "searchable@gmail.com")

        empty = self.client.get("/api/admin/staff/?search=does-not-exist")
        self.assertEqual(empty.data["count"], 0)
        cleared = self.client.get("/api/admin/staff/")
        self.assertEqual(cleared.data["count"], Staff.objects.count())

        deactivated = self.client.post(f"/api/admin/staff/{created.data['id']}/deactivate/")
        self.assertEqual(deactivated.status_code, 200)
        self.assertFalse(User.objects.get(staff_id=created.data["id"]).is_active)

    def test_staff_update_reflects_in_list_and_password_reset_requires_confirmation(self):
        created = self.client.post("/api/admin/staff/", self.staff_payload("RECEPTIONIST", "updatable"), format="json")
        self.assertEqual(created.status_code, 201, created.data)
        updated = self.client.patch(
            f"/api/admin/staff/{created.data['id']}/",
            {"designation": "Senior Receptionist"},
            format="json",
        )
        self.assertEqual(updated.status_code, 200, updated.data)
        self.assertEqual(updated.data["designation"], "Senior Receptionist")

        account = User.objects.get(staff_id=created.data["id"])
        reset = self.client.post(
            f"/api/admin/users/{account.pk}/reset-password/",
            {"password": "GreenMeadow!7384", "confirmPassword": "Mismatch!12345"},
            format="json",
        )
        self.assertEqual(reset.status_code, 400)
        self.assertFalse(account.check_password("GreenMeadow!7384"))

        reset = self.client.post(
            f"/api/admin/users/{account.pk}/reset-password/",
            {"password": "GreenMeadow!7384", "confirmPassword": "GreenMeadow!7384"},
            format="json",
        )
        self.assertEqual(reset.status_code, 200, reset.data)
        account.refresh_from_db()
        self.assertTrue(account.check_password("GreenMeadow!7384"))

    def test_admin_endpoints_reject_unauthorized_and_other_roles(self):
        self.client.force_authenticate(user=None)
        self.assertEqual(self.client.get("/api/admin/staff/").status_code, 401)

        receptionist_role = Role.objects.create(role_id="RECEPTIONIST", role_name="Receptionist")
        receptionist_staff = Staff.objects.create(name="Reception User", role=receptionist_role)
        receptionist = User(staff=receptionist_staff, username="reception.test", role=receptionist_role)
        receptionist.set_password(self.password)
        receptionist.save()
        self.client.force_authenticate(user=receptionist)
        self.assertEqual(self.client.get("/api/admin/staff/").status_code, 403)

    def test_admin_screen_read_endpoints_are_mounted_and_serializable(self):
        urls = (
            "/api/admin/roles/",
            "/api/admin/staff/",
            "/api/admin/users/",
            "/api/admin/departments/",
            "/api/admin/lab-catalog/",
            "/api/admin/suppliers/",
            "/api/admin/audit-log/",
            "/api/admin/dashboard/",
            "/api/admin/reports/?type=appointments",
            "/api/admin/settings/",
        )
        for url in urls:
            with self.subTest(url=url):
                self.assertEqual(self.client.get(url).status_code, 200)

    def test_global_search_returns_safe_user_and_staff_matches(self):
        doctor_role = Role.objects.create(role_id="DOCTOR", role_name="Doctor")
        staff = Staff.objects.create(
            name="Justin Thomas",
            designation="Surgeon",
            role=doctor_role,
            email="justin@gmail.com",
            phone="9876543210",
        )
        account = User(staff=staff, username="justin.doctor", role=doctor_role)
        account.set_password(self.password)
        account.save()
        staff_only = Staff.objects.create(
            name="Justin Lab Staff",
            designation="Lab Assistant",
            role=doctor_role,
            email="lab.justin@gmail.com",
            phone="5551234567",
        )

        account_search = self.client.get("/api/admin/search/", {"q": "JUSTIN.DOCTOR"})
        self.assertEqual(account_search.status_code, 200, account_search.data)
        self.assertEqual(len(account_search.data["results"]), 1)
        user_result = account_search.data["results"][0]
        self.assertEqual(user_result["category"], "user")
        self.assertEqual(user_result["username"], account.username)
        self.assertEqual(user_result["email"], staff.email)
        self.assertEqual(user_result["role"], "Doctor")
        self.assertEqual(user_result["designation"], "Surgeon")
        self.assertNotIn("password", user_result)
        self.assertNotIn("password_hash", user_result)

        staff_search = self.client.get("/api/admin/search/", {"q": "555123"})
        self.assertEqual(staff_search.status_code, 200, staff_search.data)
        self.assertEqual(len(staff_search.data["results"]), 1)
        self.assertEqual(staff_search.data["results"][0]["category"], "staff")
        self.assertEqual(staff_search.data["results"][0]["name"], staff_only.name)

        insensitive_search = self.client.get("/api/admin/search/", {"q": "justin@GMAIL.COM"})
        self.assertEqual(insensitive_search.status_code, 200)
        self.assertTrue(any(row["category"] == "staff" for row in insensitive_search.data["results"]))

    def test_global_search_empty_missing_long_and_unmatched_queries(self):
        for params in ({}, {"q": "  "}):
            response = self.client.get("/api/admin/search/", params)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.data, {"results": []})

        unmatched = self.client.get("/api/admin/search/", {"q": "nothing-matches-this"})
        self.assertEqual(unmatched.status_code, 200)
        self.assertEqual(unmatched.data, {"results": []})

        too_long = self.client.get("/api/admin/search/", {"q": "x" * 101})
        self.assertEqual(too_long.status_code, 400)
        self.assertIn("q", too_long.data)

    def test_global_search_requires_admin_permission(self):
        self.client.force_authenticate(user=None)
        self.assertEqual(self.client.get("/api/admin/search/", {"q": "admin"}).status_code, 401)

        receptionist_role = Role.objects.create(role_id="RECEPTIONIST", role_name="Receptionist")
        receptionist_staff = Staff.objects.create(name="Reception User", role=receptionist_role)
        receptionist = User(staff=receptionist_staff, username="reception.search", role=receptionist_role)
        receptionist.set_password(self.password)
        receptionist.save()
        self.client.force_authenticate(user=receptionist)
        self.assertEqual(self.client.get("/api/admin/search/", {"q": "Reception"}).status_code, 403)

    def test_lab_catalog_can_be_created_and_listed_with_validation(self):
        payload = {
            "name": "Complete Blood Count",
            "code": "CBC",
            "category": "Hematology",
            "sampleType": "Blood",
            "parameters": [
                {"name": "Hemoglobin", "unit": "g/dL", "refMin": 12.0, "refMax": 17.5},
                {"name": "Hematocrit", "unit": "%", "refMin": 36, "refMax": 53},
            ],
            "turnaroundHrs": 8,
            "description": "Complete blood count profile",
            "price": 125000,
            "isActive": True,
        }
        created = self.client.post("/api/admin/lab-catalog/", payload, format="json")
        self.assertEqual(created.status_code, 201, created.data)
        self.assertEqual(created.data["name"], payload["name"])
        self.assertEqual(created.data["price"], payload["price"])
        self.assertEqual(created.data["parameters"], payload["parameters"])
        self.assertEqual(LabTestCatalog.objects.count(), 1)

        price_update = self.client.patch(
            f"/api/admin/lab-catalog/{created.data['id']}/",
            {"price": 135000},
            format="json",
        )
        self.assertEqual(price_update.status_code, 200, price_update.data)
        self.assertEqual(price_update.data["price"], 135000)

        listed = self.client.get("/api/admin/lab-catalog/")
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(listed.data["count"], 1)
        lab_catalog = self.client.get("/api/lab-catalog/")
        self.assertEqual(lab_catalog.status_code, 200)
        visible_test = next(row for row in lab_catalog.data["results"] if row["id"] == created.data["id"])
        self.assertEqual(visible_test["parameters"], payload["parameters"])

        duplicate = self.client.post("/api/admin/lab-catalog/", payload, format="json")
        self.assertEqual(duplicate.status_code, 400)
        self.assertIn("name", duplicate.data)

        invalid = self.client.post("/api/admin/lab-catalog/", {**payload, "name": " ", "code": "CBC2", "turnaroundHrs": 0}, format="json")
        self.assertEqual(invalid.status_code, 400)
        self.assertIn("name", invalid.data)
        self.assertIn("turnaroundHrs", invalid.data)

        invalid_code = self.client.post(
            "/api/admin/lab-catalog/",
            {**payload, "name": "Invalid Code Test", "code": "bad code"},
            format="json",
        )
        self.assertEqual(invalid_code.status_code, 400)
        self.assertIn("code", invalid_code.data)

        invalid_parameters = self.client.post(
            "/api/admin/lab-catalog/",
            {
                **payload,
                "name": "Invalid Parameters Test",
                "code": "BADPARAM",
                "parameters": [{"name": "Sodium", "refMin": -1, "refMax": 5, "criticalMin": 0}],
            },
            format="json",
        )
        self.assertEqual(invalid_parameters.status_code, 400)
        self.assertIn("parameters", invalid_parameters.data)

    def test_catalog_edit_preserves_parameters_used_by_saved_results(self):
        catalog = LabTestCatalog.objects.create(
            test_catalog_id="safe-edit",
            test_name="Safe Edit Test",
            code="SAFEEDIT",
            category="Hematology",
            parameters=[
                {"name": "Hemoglobin", "unit": "g/dL", "refMin": 12, "refMax": 17},
                {"name": "Hematocrit", "unit": "%", "refMin": 36, "refMax": 53},
            ],
        )
        doctor_role = Role.objects.create(role_id="DOCTOR", role_name="Doctor")
        doctor_staff = Staff.objects.create(name="Catalog Test Doctor", role=doctor_role)
        doctor = Doctor.objects.create(doctor_id="cat-doctor", staff=doctor_staff)
        patient = Patient.objects.create(patient_id="cat-patient", name="Catalog Test Patient")
        lab_test = LabTest.objects.create(
            test_id="cat-lab-test",
            patient=patient,
            doctor=doctor,
            test_catalog=catalog,
            ordered_date=date.today(),
        )
        LabTestResult.objects.create(
            result_id="catalog-result",
            test=lab_test,
            performed_by=self.admin_staff,
            result_date=date.today(),
            results=[{"parameter": "Hemoglobin", "value": "14"}],
        )

        response = self.client.patch(
            f"/api/admin/lab-catalog/{catalog.pk}/",
            {"parameters": [{"name": "Hematocrit", "unit": "%", "refMin": 37, "refMax": 52}]},
            format="json",
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("Cannot remove or rename 'Hemoglobin'", str(response.data["parameters"]))

        allowed_edit = self.client.patch(
            f"/api/admin/lab-catalog/{catalog.pk}/",
            {"parameters": [
                {"name": "Hemoglobin", "unit": "g/dL", "refMin": 13, "refMax": 17},
                {"name": "Hematocrit", "unit": "%", "refMin": 37, "refMax": 52},
                {"name": "RBC Count", "unit": "million/µL"},
            ]},
            format="json",
        )
        self.assertEqual(allowed_edit.status_code, 200, allowed_edit.data)
        self.assertEqual(len(allowed_edit.data["parameters"]), 3)
        self.assertEqual(allowed_edit.data["parameters"][0]["refMin"], 13)
        saved_result = LabTestResult.objects.get(pk="catalog-result")
        self.assertEqual(saved_result.results, [{"parameter": "Hemoglobin", "value": "14"}])

    def test_supplier_can_be_created_and_listed_with_validation(self):
        payload = {
            "name": "Central Medical Supplies",
            "contactPerson": "Asha Kumar",
            "phone": "9876543210",
            "email": "asha@example.com",
            "address": "12 Clinic Road",
            "typicalMedicines": ["Paracetamol", "Amoxicillin"],
            "isActive": True,
        }
        created = self.client.post("/api/admin/suppliers/", payload, format="json")
        self.assertEqual(created.status_code, 201, created.data)
        self.assertEqual(created.data["name"], payload["name"])
        self.assertEqual(created.data["typicalMedicines"], payload["typicalMedicines"])
        self.assertEqual(Supplier.objects.count(), 1)

        listed = self.client.get("/api/admin/suppliers/")
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(listed.data["count"], 1)

        invalid = self.client.post("/api/admin/suppliers/", {"name": " ", "typicalMedicines": "not-an-array"}, format="json")
        self.assertEqual(invalid.status_code, 400)
        self.assertIn("name", invalid.data)
        self.assertIn("typicalMedicines", invalid.data)

    def test_department_head_doctor_can_be_assigned_cleared_and_must_be_a_doctor(self):
        doctor_role = Role.objects.create(role_id="DOCTOR", role_name="Doctor")
        doctor = Staff.objects.create(name="Department Doctor", role=doctor_role, designation="Cardiologist")
        receptionist_role = Role.objects.create(role_id="RECEPTIONIST", role_name="Receptionist")
        receptionist = Staff.objects.create(name="Front Desk", role=receptionist_role)

        created = self.client.post("/api/admin/departments/", {
            "name": "Cardiology Unit",
            "code": "CARD-UNIT",
            "defaultFee": 50000,
            "headDoctorIdInput": doctor.pk,
        }, format="json")
        self.assertEqual(created.status_code, 201, created.data)
        self.assertEqual(created.data["headDoctorId"], doctor.pk)
        self.assertEqual(created.data["headDoctorName"], doctor.name)
        self.assertEqual(Department.objects.get(pk=created.data["id"]).head_doctor_id, doctor.pk)

        invalid = self.client.patch(
            f"/api/admin/departments/{created.data['id']}/",
            {"headDoctorIdInput": receptionist.pk},
            format="json",
        )
        self.assertEqual(invalid.status_code, 400)
        self.assertIn("headDoctorIdInput", invalid.data)

        cleared = self.client.patch(
            f"/api/admin/departments/{created.data['id']}/",
            {"headDoctorIdInput": ""},
            format="json",
        )
        self.assertEqual(cleared.status_code, 200, cleared.data)
        self.assertIsNone(cleared.data["headDoctorId"])

    def test_department_doctor_list_can_be_filtered_by_doctor_role(self):
        doctor_role = Role.objects.create(role_id="DOCTOR", role_name="Doctor")
        doctor = Staff.objects.create(name="Selectable Doctor", role=doctor_role)
        receptionist_role = Role.objects.create(role_id="RECEPTIONIST", role_name="Receptionist")
        Staff.objects.create(name="Not a Doctor", role=receptionist_role)

        response = self.client.get("/api/admin/staff/", {"role": "DOCTOR"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual([row["id"] for row in response.data["results"]], [doctor.pk])
