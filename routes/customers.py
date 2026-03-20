"""
Customer search routes.
Reads from the `customers` collection (managed by customer_service).
"""

from flask import Blueprint, request, jsonify
from config import logger
from services import customer_service

customers_bp = Blueprint('customers', __name__)


@customers_bp.route("/search_customers", methods=["POST"])
def search_customers_route():
    """
    Search returning guests by name, mobile, or ID number.
    Used by the check-in form to auto-fill returning guest details.
    """
    try:
        data_json = request.json
        query_str = data_json.get("query", "").strip()
        if not query_str:
            return jsonify(success=True, customers=[])

        results = customer_service.search_customers(query_str, limit=10)

        customers = []
        for c in results:
            customers.append({
                "name": c.get("name", ""),
                "mobile": c.get("mobile", ""),
                "id_type": c.get("id_type", ""),
                "id_number": c.get("id_number", ""),
                "address": c.get("address", ""),
                "id_doc_urls": c.get("id_doc_urls", []),
                "total_stays": c.get("total_stays", 0),
                "total_spent": c.get("total_spent", 0),
                "first_visit": c.get("first_visit", ""),
                "last_stay_date": c.get("last_stay_date", ""),
            })

        return jsonify(success=True, customers=customers)
    except Exception as e:
        logger.error(f"Error searching customers: {str(e)}")
        return jsonify(success=False, message=f"Error: {str(e)}")


@customers_bp.route("/get_customer/<mobile>", methods=["GET"])
def get_customer_route(mobile):
    """Get a single customer record by mobile number."""
    try:
        customer = customer_service.get_customer(mobile)
        if customer:
            customer.pop("_id", None)
            return jsonify(success=True, customer=customer)
        return jsonify(success=False, message="Customer not found")
    except Exception as e:
        logger.error(f"Error getting customer: {str(e)}")
        return jsonify(success=False, message=f"Error: {str(e)}")
