# eTA Backend

Cloudflare Worker that receives Shopify form submissions and stores them in Airtable.

## Project Structure 

- `src/index.js` — the worker logic (CORS, validation, Airtable write, email fallback)
- `wrangler.toml` — Cloudflare Worker config
- `package.json` — project metadata and scripts
- `.dev.vars.example` — template for local secrets
- `.gitignore` — keeps secrets out of git

## Design Choices  
### 1. Accounts Used (free tiers)

| Service | Why | URL |
|---------|-----|-----|
| Cloudflare | Host the worker | https://dash.cloudflare.com |
| Airtable | Store submissions | https://airtable.com |
| Resend | Email fallback if Airtable fails | https://resend.com |

### 2. Airtable Schema

| Field Name | Type |
|---|---|
| email | Email |
| email_confirm | Email |
| passport_issuing_country | Single line text |
| passport_issuing_country_name | Single line text |
| passport_nationality | Single line text |
| passport_nationality_name | Single line text |
| passport_number | Single line text |
| passport_number_confirm | Single line text |
| surname | Single line text |
| given_names | Single line text |
| gender | Single select |
| gender_name | Single line text |
| date_of_birth | Date |
| country_of_birth | Single line text |
| country_of_birth_name | Single line text |
| passport_issue_date | Date |
| passport_expiry_date | Date |
| other_citizen | Single select (Yes/No) |
| citizenship_countries | Long text |
| citizenship_countries_codes | Single line text |
| applied_canada | Single select (Yes/No) |
| uci | Single line text |
| uci_confirm | Single line text |
| apt_unit | Single line text |
| street_civic | Single line text |
| street_name | Single line text |
| street_name_2 | Single line text |
| city_town | Single line text |
| address_country | Single line text |
| address_country_name | Single line text |
| district_region | Single line text |
| know_travel_date | Single select (Yes/No) |
| flight_departure_date | Date |
| flight_departure_time | Single line text |
| flight_departure_time_name | Single line text |
| payment_method | Single select |
| billing_name | Single line text |
| declaration_reviewed | Checkbox |
| declaration_truthful | Checkbox |
| declaration_signature_agree | Checkbox |
| signature | Single line text |
| submitted_at | Date/Time |
| source | Single line text |


### 3. Resend API

Safety net route introduced. In case the Airtable entry fails an email is sent containing the applicant data. 

### 4. Cloudflare Deploy

The worker is live at `https://eta-backend.candaeta.workers.dev`.

### 5. Connected to Shopify

In your Shopify admin, Application Form section is set:
- **API endpoint**: `https://eta-backend.candaeta.workers.dev`

The frontend will POST to this URL automatically.
