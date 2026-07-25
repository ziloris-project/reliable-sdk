---
"@reliableapp/frontend-core": minor
"@reliableapp/react": minor
---

Correlate JS errors with the network request that caused them. When an error
is triggered by a recently-finished request (api_response trigger), the SDK
now attaches that request's event UUID (`network_event_uuid`) to the error
payload, so the dashboard can link a JS error to its failing API call and show
the request/response inline. Previously the recent-network buffer was used only
to classify the trigger and the correlation was dropped.
