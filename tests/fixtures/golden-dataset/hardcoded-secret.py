# Intentionally vulnerable fixture for the golden-dataset regression suite.
# DO NOT use this pattern in real code.

import requests

# VULNERABLE: hardcoded API key / secret committed directly in source
STRIPE_API_KEY = "sk_live_51Hxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"


def charge_customer(customer_id, amount_cents):
    response = requests.post(
        "https://api.stripe.com/v1/charges",
        auth=(STRIPE_API_KEY, ""),
        data={"customer": customer_id, "amount": amount_cents, "currency": "usd"},
    )
    return response.json()


def load_config(path="config.yml"):
    import yaml

    with open(path) as f:
        # VULNERABLE: yaml.load without SafeLoader can execute arbitrary code
        return yaml.load(f)
