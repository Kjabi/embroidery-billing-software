# Business Tool Registry

The canonical registry is `voice_tools.TOOLS`. `hybrid_ai.allowed_tool_names()`
reads that registry rather than duplicating names. Every tool call is validated
by the existing Pydantic argument models and runs through the authenticated
backend context.

Read tools include business summaries, sales, payment history, order lists,
customer/product search, customer/order details, balances, measurements, and
reports. Write tools prepare customer/order/payment/status/delivery/measurement
operations; `voice_tools.execute_pending()` performs the save only after the
existing confirmation endpoint validates session ownership, expiry, and phrase.

The LLM is not an authorization layer and cannot execute arbitrary SQL.
