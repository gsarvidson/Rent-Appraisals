# Homes.co.nz Rent Appraisal Logic

## Overview
Homes.co.nz calculates a rent appraisal value (range) for residential properties using a combination of real listing data and a machine learning model. The output is a predicted weekly rent with a lower/upper range.

---

## 1. Data Sources

Three rental data sources are combined (`main.r:20-41`):

| Source | Type | Description |
|--------|------|-------------|
| XML Feed (`loadXML`) | Active/leased listings | From the DB with price, bed, bath |
| Appraisals (`loadAppraisals`) | Manual appraisals | From support tickets via CSV |
| Online listings (`loadJSON_s3`) | Scraped listings | From TradeMe/RealEstate, exported from Athena |

**Deduplication:** Where a property appears in multiple sources, the most recent rental record is kept.

---

## 2. Outlier Filtering

Function: `filterOutliers` (`global.r:362-414`)

Noise is removed using the **yield ratio**: `52 × weekly_rent / estimated_value`

Rules:
- Drop the top and bottom **2% of yields** per Territorial Authority (TA)
- Drop TAs with **fewer than 100 rental observations**
- Exclude property categories: `RC`, `RH`, `RN`, `RR` (caravans, hostels, etc.)

---

## 3. Model Architecture

(`main.r:132-145`)

- **Algorithm:** Random Forest (`randomForest`, 200 trees, `mtry=2`)
- **Scope:** One model trained **per TA** — independently per region
- **Target variable:** Weekly `rent`
- **Features:**
  - `estimated_value`
  - `floor_area_m2`
  - `category`
  - `longitude`
  - `latitude`
  - `improvement_value`
- **Train/test split:** 75/25, stratified by TA, `set.seed(100)`

---

## 4. Range Calculation

Function: `Range_calculator` (`global.r:417-465`)

For each prediction, finds the **minimum symmetric percentage range** that captures exactly **50% of actual rents**, using Brent's optimisation method.

```
lwr = pred × (1 - range_percentage)
upr = pred × (1 + range_percentage)
```

- The range percentage **varies per TA** to reflect local market volatility.
- A more volatile market → wider range; a stable market → narrower range.

---

## 5. Prediction Pipeline

(`main.r:311-390`)

- **Scope:** All residential properties with category codes `rd*`, `rf*`, `ra*`
- **Extrapolation guard:** Predictions are only made where `estimated_value < p98_HE` (98th percentile of estimated values in training data per TA), to avoid predictions in sparse/unreliable regions.

---

## 6. Source vs Estimated Output

(`main.r:438-450`)

The final output **prefers actual listing data** over model predictions:

| Condition | `pred` value | `source` label |
|-----------|-------------|----------------|
| Property has a known listing price | Listing price used directly | `'listing'` |
| No listing price available | Model prediction used | `'estimated'` |

---

## 7. Display Format

The UI shows:

```
RentEstimate: {date}
${lwr} — ${upr}/week

Estimated rental yield
{yield}%
```

- **Range:** `lwr` and `upr` rounded to nearest $10 (or $5)
- **Yield:** `52 × pred / estimated_value × 100`, displayed to 1 decimal place
- The midpoint `pred` is not shown directly — only the range bounds are displayed
- Labelled as "computer generated price guides only"

Example: `lwr=$600`, `upr=$710` → midpoint `pred≈$655`, yield `52×655/estimated_value`

---

## Summary Flow

```
Raw rental data (XML + Appraisals + Online listings)
    → Deduplicate (keep most recent per property)
    → Filter outliers (yield ratio, TA minimums, exclude categories)
    → Train Random Forest model per TA
    → Predict weekly rent for all residential properties
    → Calculate symmetric range (captures 50% of actuals) per TA
    → Override with actual listing price where available
    → Output: pred, lwr, upr, source
```
