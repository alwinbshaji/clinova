"""
cms_labapp/tests.py
Automated test suite for Lab domain:
- Lab catalog list, retrieve, price in paise
- Admin price update in paise
- Lab result list
- Role permissions (LAB_TECH, ADMIN, PHARMACIST, Anonymous)
"""

from decimal import Decimal
from django.core.management import call_command
from rest_framework import status
from rest_framework.test import APITestCase
from rest_framework_simplejwt.tokens import RefreshToken

from cms_backendapp.models import Role, Staff, User, LabTestCatalog
from cms_recepapp.models import Patient
from cms_doctorapp.models import Doctor, LabTest
from cms_labapp.models import LabTestResult


class LabDomainTests(APITestCase):
    def setUp(self):
        # Roles
        self.role_admin = Role.objects.create(role_id="ADMIN", role_name="Administrator")
        self.role_lab = Role.objects.create(role_id="LAB_TECH", role_name="Lab Technician")
        self.role_pharm = Role.objects.create(role_id="PHARMACIST", role_name="Pharmacist")

        # Staff & Users
        self.staff_admin = Staff.objects.create(
            staff_id="staff-adm-01",
            name="Admin User",
            email="admin@clinova.test",
            role=self.role_admin,
            is_active=True,
        )
        self.user_admin = User.objects.create(
            user_id="user-adm-01",
            username="adminuser",
            role=self.role_admin,
            staff=self.staff_admin,
            is_active=True,
        )
        self.user_admin.set_password("Pass@123")
        self.user_admin.save()

        self.staff_lab = Staff.objects.create(
            staff_id="staff-lab-01",
            name="Lab Technician",
            email="tech@clinova.test",
            role=self.role_lab,
            is_active=True,
        )
        self.user_lab = User.objects.create(
            user_id="user-lab-01",
            username="labtech",
            role=self.role_lab,
            staff=self.staff_lab,
            is_active=True,
        )
        self.user_lab.set_password("Pass@123")
        self.user_lab.save()

        self.staff_pharm = Staff.objects.create(
            staff_id="staff-pharm-01",
            name="Pharmacist",
            email="pharm@clinova.test",
            role=self.role_pharm,
            is_active=True,
        )
        self.user_pharm = User.objects.create(
            user_id="user-pharm-01",
            username="pharmuser",
            role=self.role_pharm,
            staff=self.staff_pharm,
            is_active=True,
        )
        self.user_pharm.set_password("Pass@123")
        self.user_pharm.save()

        # Catalog item
        self.catalog = LabTestCatalog.objects.create(
            test_catalog_id="test-01",
            test_name="Complete Blood Count",
            code="CBC",
            category="Hematology",
            price=Decimal("350.00"),
            turnaround_hrs=2,
            is_active=True,
        )

    def auth_headers(self, user):
        token = RefreshToken.for_user(user).access_token
        return {"HTTP_AUTHORIZATION": f"Bearer {token}"}

    def test_catalog_list_and_price_in_paise(self):
        url = "/api/lab-catalog/"
        headers = self.auth_headers(self.user_lab)
        res = self.client.get(url, **headers)
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        # price: 350.00 -> 35000 paise
        self.assertEqual(res.data["results"][0]["price"], 35000)

    def test_admin_update_catalog_price(self):
        url = f"/api/lab-catalog/{self.catalog.test_catalog_id}/"
        headers_adm = self.auth_headers(self.user_admin)

        # Update price to 40000 paise (₹400)
        res = self.client.patch(url, {"price": 40000}, format="json", **headers_adm)
        self.assertEqual(res.status_code, status.HTTP_200_OK)
        self.assertEqual(res.data["price"], 40000)

        self.catalog.refresh_from_db()
        self.assertEqual(self.catalog.price, Decimal("400.00"))

    def test_only_admin_can_create_tests_and_lab_tech_can_update_only_ranges(self):
        headers_lab = self.auth_headers(self.user_lab)
        lab_create = self.client.post(
            "/api/lab-catalog/",
            {
                "name": "Serum Calcium",
                "code": "CA",
                "category": "Biochemistry",
                "sampleType": "Serum",
                "turnaroundHrs": 3,
                "parameters": [
                    {
                        "name": "Calcium",
                        "unit": "mg/dL",
                        "dataType": "number",
                        "required": True,
                        "refMin": 8.5,
                        "refMax": 10.5,
                        "criticalMin": 6.0,
                        "criticalMax": 14.0,
                    }
                ],
            },
            format="json",
            **headers_lab,
        )
        self.assertEqual(lab_create.status_code, status.HTTP_403_FORBIDDEN)
        admin_api_lab_create = self.client.post(
            "/api/admin/lab-catalog/",
            {"name": "Serum Sodium", "parameters": [{"name": "Sodium"}]},
            format="json",
            **headers_lab,
        )
        self.assertEqual(admin_api_lab_create.status_code, status.HTTP_403_FORBIDDEN)

        created = self.client.post(
            "/api/lab-catalog/",
            {
                "name": "Serum Calcium",
                "code": "CA",
                "category": "Biochemistry",
                "sampleType": "Serum",
                "turnaroundHrs": 3,
                "parameters": [
                    {
                        "name": "Calcium",
                        "unit": "mg/dL",
                        "dataType": "number",
                        "required": True,
                        "refMin": 8.5,
                        "refMax": 10.5,
                        "criticalMin": 6.0,
                        "criticalMax": 14.0,
                    }
                ],
            },
            format="json",
            **self.auth_headers(self.user_admin),
        )
        self.assertEqual(created.status_code, status.HTTP_201_CREATED)
        self.assertEqual(created.data["price"], 0)
        test_id = created.data["id"]

        updated = self.client.patch(
            f"/api/lab-catalog/{test_id}/",
            {
                "parameters": [
                    {
                        "name": "Calcium",
                        "refMin": 8.8,
                        "refMax": 10.2,
                        "criticalMin": 6.0,
                        "criticalMax": 14.0,
                    }
                ]
            },
            format="json",
            **headers_lab,
        )
        self.assertEqual(updated.status_code, status.HTTP_200_OK)
        self.assertEqual(updated.data["parameters"][0]["refMin"], 8.8)

        forbidden = self.client.patch(
            f"/api/lab-catalog/{test_id}/",
            {"price": 50000},
            format="json",
            **headers_lab,
        )
        self.assertEqual(forbidden.status_code, status.HTTP_403_FORBIDDEN)

        changed_parameter = self.client.patch(
            f"/api/lab-catalog/{test_id}/",
            {"parameters": [{"name": "Potassium", "refMin": 3.5, "refMax": 5.0}]},
            format="json",
            **headers_lab,
        )
        self.assertEqual(changed_parameter.status_code, status.HTTP_400_BAD_REQUEST)

    def test_lab_permissions(self):
        # Pharmacist attempting to modify catalog -> 403 Forbidden
        headers_pharm = self.auth_headers(self.user_pharm)
        res_pharm = self.client.patch(f"/api/lab-catalog/{self.catalog.test_catalog_id}/", {"price": 50000}, format="json", **headers_pharm)
        self.assertEqual(res_pharm.status_code, status.HTTP_403_FORBIDDEN)

        # Unauthenticated request -> 401
        res_anon = self.client.get("/api/lab-catalog/")
        self.assertEqual(res_anon.status_code, status.HTTP_401_UNAUTHORIZED)

        res_lab_dashboard = self.client.get("/api/dashboard/lab/", **self.auth_headers(self.user_lab))
        self.assertEqual(res_lab_dashboard.status_code, status.HTTP_200_OK)
        res_pharm_dashboard = self.client.get("/api/dashboard/lab/", **headers_pharm)
        self.assertEqual(res_pharm_dashboard.status_code, status.HTTP_403_FORBIDDEN)

    def test_sync_demo_lab_ranges_only_fills_missing_values(self):
        catalog = LabTestCatalog.objects.create(
            test_catalog_id="test-03",
            test_name="HbA1c",
            code="HBA1C",
            category="Biochemistry",
            parameters=[{
                "name": "HbA1c",
                "unit": "%",
                "refMin": 4,
                "refMax": 5.6,
                "criticalMin": None,
                "criticalMax": 14,
            }],
        )

        call_command("sync_demo_lab_ranges", verbosity=0)

        catalog.refresh_from_db()
        parameter = catalog.parameters[0]
        self.assertEqual(parameter["criticalMin"], 2)
        self.assertEqual(parameter["refMin"], 4)
        self.assertEqual(parameter["criticalMax"], 14)
        self.assertEqual(parameter["rangeSource"], "ILLUSTRATIVE_DEMO")
