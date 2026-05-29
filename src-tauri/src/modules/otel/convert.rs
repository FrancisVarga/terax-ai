//! OTLP proto -> normalized rows. Pure functions, no IO.
//!
//! The `opentelemetry-proto` `with-serde` codec already decoded trace/span ids
//! from hex (or base64) into raw bytes and int64 timestamps from decimal
//! strings, so here the bytes are re-hex-encoded to canonical lowercase strings
//! and `AnyValue` is rendered into plain `serde_json::Value` for storage.

use opentelemetry_proto::tonic::common::v1::{any_value::Value as AnyVal, AnyValue, KeyValue};
use opentelemetry_proto::tonic::logs::v1::ResourceLogs;
use opentelemetry_proto::tonic::metrics::v1::{metric::Data as MetricData, ResourceMetrics};
use opentelemetry_proto::tonic::trace::v1::ResourceSpans;
use serde_json::{json, Map, Value};

use super::model::{LogRow, MetricRow, SpanRow};

/// Lowercase hex of a byte slice. Empty in -> empty out (root span parent, etc.).
fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(char::from_digit((b >> 4) as u32, 16).unwrap());
        s.push(char::from_digit((b & 0xf) as u32, 16).unwrap());
    }
    s
}

/// Render an OTLP `AnyValue` into a JSON value the frontend can display.
/// int64 (`IntValue`) is kept as a JSON number; values that exceed f64's exact
/// integer range are rare in attributes and acceptable to widen for display.
fn any_value_to_json(v: &AnyValue) -> Value {
    match &v.value {
        Some(AnyVal::StringValue(s)) => Value::String(s.clone()),
        Some(AnyVal::BoolValue(b)) => Value::Bool(*b),
        Some(AnyVal::IntValue(i)) => json!(*i),
        Some(AnyVal::DoubleValue(d)) => json!(*d),
        Some(AnyVal::ArrayValue(arr)) => {
            Value::Array(arr.values.iter().map(any_value_to_json).collect())
        }
        Some(AnyVal::KvlistValue(kv)) => kv_to_json(&kv.values),
        Some(AnyVal::BytesValue(b)) => Value::String(hex(b)),
        None => Value::Null,
    }
}

/// A list of OTLP `KeyValue` -> a JSON object `{ key: value }`.
fn kv_to_json(kvs: &[KeyValue]) -> Value {
    let mut map = Map::with_capacity(kvs.len());
    for kv in kvs {
        let val = kv.value.as_ref().map(any_value_to_json).unwrap_or(Value::Null);
        map.insert(kv.key.clone(), val);
    }
    Value::Object(map)
}

/// Render an `AnyValue` as a flat display string for the log body column.
fn any_value_to_text(v: &AnyValue) -> String {
    match &v.value {
        Some(AnyVal::StringValue(s)) => s.clone(),
        Some(AnyVal::BoolValue(b)) => b.to_string(),
        Some(AnyVal::IntValue(i)) => i.to_string(),
        Some(AnyVal::DoubleValue(d)) => d.to_string(),
        Some(AnyVal::BytesValue(b)) => hex(b),
        // Structured bodies are uncommon; serialize them compactly.
        Some(other) => {
            let wrapped = AnyValue {
                value: Some(other.clone()),
            };
            any_value_to_json(&wrapped).to_string()
        }
        None => String::new(),
    }
}

/// Pull `service.name` from a resource attribute set, defaulting to "unknown".
fn service_name(resource_attrs: &Value) -> String {
    resource_attrs
        .get("service.name")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string()
}

/// Flatten a batch of `ResourceSpans` into span rows, stamped with `received_ms`.
pub fn spans_from_resource(rs: &[ResourceSpans], received_ms: i64) -> Vec<SpanRow> {
    let mut out = Vec::new();
    for r in rs {
        let resource = r
            .resource
            .as_ref()
            .map(|res| kv_to_json(&res.attributes))
            .unwrap_or(Value::Null);
        let service = service_name(&resource);
        for scope in &r.scope_spans {
            let scope_name = scope.scope.as_ref().map(|s| s.name.clone()).unwrap_or_default();
            for span in &scope.spans {
                let events = Value::Array(
                    span.events
                        .iter()
                        .map(|e| {
                            json!({
                                "name": e.name,
                                "timeNano": e.time_unix_nano,
                                "attributes": kv_to_json(&e.attributes),
                            })
                        })
                        .collect(),
                );
                let (status_code, status_message) = span
                    .status
                    .as_ref()
                    .map(|s| (s.code, s.message.clone()))
                    .unwrap_or((0, String::new()));
                let duration = span.end_time_unix_nano.saturating_sub(span.start_time_unix_nano);
                out.push(SpanRow {
                    trace_id: hex(&span.trace_id),
                    span_id: hex(&span.span_id),
                    parent_span_id: hex(&span.parent_span_id),
                    name: span.name.clone(),
                    service: service.clone(),
                    kind: span.kind,
                    start_nano: span.start_time_unix_nano,
                    end_nano: span.end_time_unix_nano,
                    duration_nano: duration,
                    status_code,
                    status_message,
                    scope_name: scope_name.clone(),
                    attributes: kv_to_json(&span.attributes),
                    resource: resource.clone(),
                    events,
                    received_ms,
                });
            }
        }
    }
    out
}

/// Flatten a batch of `ResourceLogs` into log rows.
pub fn logs_from_resource(rl: &[ResourceLogs], received_ms: i64) -> Vec<LogRow> {
    let mut out = Vec::new();
    for r in rl {
        let resource = r
            .resource
            .as_ref()
            .map(|res| kv_to_json(&res.attributes))
            .unwrap_or(Value::Null);
        let service = service_name(&resource);
        for scope in &r.scope_logs {
            let scope_name = scope.scope.as_ref().map(|s| s.name.clone()).unwrap_or_default();
            for lr in &scope.log_records {
                let body = lr.body.as_ref().map(any_value_to_text).unwrap_or_default();
                out.push(LogRow {
                    time_nano: lr.time_unix_nano,
                    observed_time_nano: lr.observed_time_unix_nano,
                    severity_number: lr.severity_number,
                    severity_text: lr.severity_text.clone(),
                    body,
                    service: service.clone(),
                    scope_name: scope_name.clone(),
                    trace_id: hex(&lr.trace_id),
                    span_id: hex(&lr.span_id),
                    attributes: kv_to_json(&lr.attributes),
                    resource: resource.clone(),
                    received_ms,
                });
            }
        }
    }
    out
}

/// Flatten a batch of `ResourceMetrics` into one metric row per data point.
pub fn metrics_from_resource(rm: &[ResourceMetrics], received_ms: i64) -> Vec<MetricRow> {
    let mut out = Vec::new();
    for r in rm {
        let resource = r
            .resource
            .as_ref()
            .map(|res| kv_to_json(&res.attributes))
            .unwrap_or(Value::Null);
        let service = service_name(&resource);
        for scope in &r.scope_metrics {
            let scope_name = scope.scope.as_ref().map(|s| s.name.clone()).unwrap_or_default();
            for metric in &scope.metrics {
                let base = MetricBase {
                    name: &metric.name,
                    description: &metric.description,
                    unit: &metric.unit,
                    service: &service,
                    scope_name: &scope_name,
                    resource: &resource,
                    received_ms,
                };
                match &metric.data {
                    Some(MetricData::Gauge(g)) => {
                        push_number_points(&mut out, &base, "gauge", None, 0, &g.data_points);
                    }
                    Some(MetricData::Sum(s)) => {
                        push_number_points(
                            &mut out,
                            &base,
                            "sum",
                            Some(s.is_monotonic),
                            s.aggregation_temporality,
                            &s.data_points,
                        );
                    }
                    Some(MetricData::Histogram(h)) => {
                        for dp in &h.data_points {
                            out.push(base.row(
                                "histogram",
                                None,
                                h.aggregation_temporality,
                                dp.time_unix_nano,
                                dp.start_time_unix_nano,
                                json!({
                                    "count": dp.count,
                                    "sum": dp.sum,
                                    "bucketCounts": dp.bucket_counts,
                                    "explicitBounds": dp.explicit_bounds,
                                    "min": dp.min,
                                    "max": dp.max,
                                }),
                                kv_to_json(&dp.attributes),
                            ));
                        }
                    }
                    // Exponential histogram / summary: store count+sum where
                    // available so the point is at least visible; full bucket
                    // detail is out of scope for the local dashboard.
                    Some(MetricData::ExponentialHistogram(h)) => {
                        for dp in &h.data_points {
                            out.push(base.row(
                                "exponentialHistogram",
                                None,
                                h.aggregation_temporality,
                                dp.time_unix_nano,
                                dp.start_time_unix_nano,
                                json!({ "count": dp.count, "sum": dp.sum, "scale": dp.scale }),
                                kv_to_json(&dp.attributes),
                            ));
                        }
                    }
                    Some(MetricData::Summary(s)) => {
                        for dp in &s.data_points {
                            out.push(base.row(
                                "summary",
                                None,
                                0,
                                dp.time_unix_nano,
                                dp.start_time_unix_nano,
                                json!({ "count": dp.count, "sum": dp.sum }),
                                kv_to_json(&dp.attributes),
                            ));
                        }
                    }
                    None => {}
                }
            }
        }
    }
    out
}

/// Shared fields for the metric rows produced from one `Metric`.
struct MetricBase<'a> {
    name: &'a str,
    description: &'a str,
    unit: &'a str,
    service: &'a str,
    scope_name: &'a str,
    resource: &'a Value,
    received_ms: i64,
}

impl MetricBase<'_> {
    #[allow(clippy::too_many_arguments)]
    fn row(
        &self,
        kind: &str,
        is_monotonic: Option<bool>,
        temporality: i32,
        time_nano: u64,
        start_nano: u64,
        value: Value,
        attributes: Value,
    ) -> MetricRow {
        MetricRow {
            name: self.name.to_string(),
            description: self.description.to_string(),
            unit: self.unit.to_string(),
            kind: kind.to_string(),
            is_monotonic,
            temporality,
            service: self.service.to_string(),
            scope_name: self.scope_name.to_string(),
            time_nano,
            start_nano,
            value,
            attributes,
            resource: self.resource.clone(),
            received_ms: self.received_ms,
        }
    }
}

/// Push gauge/sum `NumberDataPoint`s as rows. `asDouble`/`asInt` is a oneof.
fn push_number_points(
    out: &mut Vec<MetricRow>,
    base: &MetricBase,
    kind: &str,
    is_monotonic: Option<bool>,
    temporality: i32,
    points: &[opentelemetry_proto::tonic::metrics::v1::NumberDataPoint],
) {
    use opentelemetry_proto::tonic::metrics::v1::number_data_point::Value as NumVal;
    for dp in points {
        let value = match &dp.value {
            Some(NumVal::AsDouble(d)) => json!({ "asDouble": d }),
            Some(NumVal::AsInt(i)) => json!({ "asInt": i }),
            None => Value::Null,
        };
        out.push(base.row(
            kind,
            is_monotonic,
            temporality,
            dp.time_unix_nano,
            dp.start_time_unix_nano,
            value,
            kv_to_json(&dp.attributes),
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
    use prost::Message;

    const TRACE_JSON: &str = r#"{
      "resourceSpans": [{
        "resource": { "attributes": [
          { "key": "service.name", "value": { "stringValue": "checkout" } }
        ]},
        "scopeSpans": [{
          "scope": { "name": "tracer" },
          "spans": [{
            "traceId": "5b8efff798038103d269b633813fc60c",
            "spanId": "eee19b7ec3c1b174",
            "name": "GET /pay",
            "kind": 2,
            "startTimeUnixNano": "1000",
            "endTimeUnixNano": "1500",
            "attributes": [
              { "key": "http.status_code", "value": { "intValue": "200" } }
            ],
            "status": { "code": 2, "message": "boom" }
          }]
        }]
      }]
    }"#;

    #[test]
    fn span_hex_ids_and_duration_and_service() {
        let req: ExportTraceServiceRequest = serde_json::from_str(TRACE_JSON).unwrap();
        let rows = spans_from_resource(&req.resource_spans, 42);
        assert_eq!(rows.len(), 1);
        let s = &rows[0];
        // Hex id round-trips back to the exact canonical lowercase string.
        assert_eq!(s.trace_id, "5b8efff798038103d269b633813fc60c");
        assert_eq!(s.span_id, "eee19b7ec3c1b174");
        assert_eq!(s.parent_span_id, "");
        assert_eq!(s.service, "checkout");
        assert_eq!(s.kind, 2);
        assert_eq!(s.start_nano, 1000);
        assert_eq!(s.duration_nano, 500);
        assert_eq!(s.status_code, 2);
        assert_eq!(s.status_message, "boom");
        assert_eq!(s.attributes["http.status_code"], json!(200));
        assert_eq!(s.received_ms, 42);
    }

    #[test]
    fn protobuf_and_json_decode_to_same_rows() {
        // The same struct decodes from both wire formats; converting either
        // yields identical rows. This locks the "one model, both wires" design.
        let from_json: ExportTraceServiceRequest = serde_json::from_str(TRACE_JSON).unwrap();
        let proto_bytes = from_json.encode_to_vec();
        let from_proto = ExportTraceServiceRequest::decode(&proto_bytes[..]).unwrap();

        let a = spans_from_resource(&from_json.resource_spans, 0);
        let b = spans_from_resource(&from_proto.resource_spans, 0);
        assert_eq!(a.len(), b.len());
        assert_eq!(a[0].trace_id, b[0].trace_id);
        assert_eq!(a[0].duration_nano, b[0].duration_nano);
        assert_eq!(a[0].service, b[0].service);
    }

    #[test]
    fn base64_trace_id_also_decodes() {
        // Some SDKs historically sent ids as base64 instead of hex. The
        // with-serde codec tolerates it; verify the bytes still re-hex cleanly.
        // base64("[0x5b,0x8e,...]") for the same 16 bytes as above.
        let b64_json = TRACE_JSON.replace(
            "\"5b8efff798038103d269b633813fc60c\"",
            "\"W47/95gDgQPSabYzgT/GDA==\"",
        );
        let req: ExportTraceServiceRequest = serde_json::from_str(&b64_json).unwrap();
        let rows = spans_from_resource(&req.resource_spans, 0);
        assert_eq!(rows[0].trace_id, "5b8efff798038103d269b633813fc60c");
    }
}
