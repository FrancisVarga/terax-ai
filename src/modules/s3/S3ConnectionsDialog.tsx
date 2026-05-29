import { useState } from "react";
import {
  Add01Icon,
  Alert02Icon,
  CloudServerIcon,
  Delete02Icon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useS3Connections } from "./lib/useS3Connections";
import type { S3Connection, S3Credentials } from "./lib/types";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** Editable form state. Credentials are write-only — we never read them back
 * from the backend, so editing an existing connection starts with blank
 * credential fields (left blank = the backend keeps the stored ones is NOT
 * assumed; the user re-enters them on edit). */
type FormState = {
  id: string;
  name: string;
  region: string;
  endpoint: string;
  forcePathStyle: boolean;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
};

function emptyForm(): FormState {
  return {
    id: crypto.randomUUID(),
    name: "",
    region: "us-east-1",
    endpoint: "",
    forcePathStyle: false,
    bucket: "",
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: "",
  };
}

function formFromConnection(conn: S3Connection): FormState {
  return {
    id: conn.id,
    name: conn.name,
    region: conn.region,
    endpoint: conn.endpoint ?? "",
    forcePathStyle: conn.force_path_style,
    bucket: conn.bucket ?? "",
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: "",
  };
}

/**
 * Manage S3 connections: list saved profiles, add/edit a form, and delete.
 * Uses `useS3Connections` for all backend I/O. New connections get a fresh
 * `crypto.randomUUID()`; editing reuses the existing id so the save overwrites.
 */
export function S3ConnectionsDialog({ open, onOpenChange }: Props) {
  const { connections, loading, error, save, remove } = useS3Connections();
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const startAdd = () => {
    setFormError(null);
    setForm(emptyForm());
  };
  const startEdit = (conn: S3Connection) => {
    setFormError(null);
    setForm(formFromConnection(conn));
  };
  const cancelForm = () => {
    setForm(null);
    setFormError(null);
  };

  const handleSave = async () => {
    if (!form) return;
    if (!form.name.trim()) {
      setFormError("Name is required.");
      return;
    }
    const conn: S3Connection = {
      id: form.id,
      name: form.name.trim(),
      region: form.region.trim(),
      endpoint: form.endpoint.trim() || null,
      force_path_style: form.forcePathStyle,
      bucket: form.bucket.trim() || null,
    };
    const creds: S3Credentials = {
      accessKeyId: form.accessKeyId,
      secretAccessKey: form.secretAccessKey,
      sessionToken: form.sessionToken.trim() || null,
    };
    setSaving(true);
    setFormError(null);
    try {
      await save(conn, creds);
      setForm(null);
    } catch (e) {
      setFormError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>S3 Connections</DialogTitle>
          <DialogDescription>
            Manage saved S3 (and S3-compatible) connection profiles.
          </DialogDescription>
        </DialogHeader>

        {form ? (
          <ConnectionForm
            form={form}
            saving={saving}
            error={formError}
            onChange={setForm}
            onCancel={cancelForm}
            onSave={() => void handleSave()}
          />
        ) : (
          <div className="flex flex-col gap-3">
            {error ? (
              <div className="flex items-start gap-2 text-[12px] text-destructive">
                <HugeiconsIcon
                  icon={Alert02Icon}
                  size={14}
                  strokeWidth={1.75}
                  className="mt-0.5 shrink-0"
                />
                <span className="break-words">{error}</span>
              </div>
            ) : null}

            {loading ? (
              <div className="flex items-center gap-2 py-4 text-[12px] text-muted-foreground">
                <Spinner className="size-3.5" />
                <span>Loading connections…</span>
              </div>
            ) : connections.length === 0 ? (
              <div className="py-6 text-center text-[12px] text-muted-foreground">
                No connections yet.
              </div>
            ) : (
              <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
                {connections.map((conn) => (
                  <li
                    key={conn.id}
                    className="flex items-center gap-2.5 rounded-md border border-border/60 px-2.5 py-2"
                  >
                    <HugeiconsIcon
                      icon={CloudServerIcon}
                      size={15}
                      strokeWidth={1.75}
                      className="shrink-0 text-muted-foreground"
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-[12.5px] font-medium text-foreground">
                        {conn.name}
                      </span>
                      <span className="truncate text-[11px] text-muted-foreground">
                        {conn.endpoint ?? "AWS"} · {conn.region}
                        {conn.bucket ? ` · ${conn.bucket}` : ""}
                      </span>
                    </span>
                    <div className="ml-auto flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Edit ${conn.name}`}
                        onClick={() => startEdit(conn)}
                      >
                        <HugeiconsIcon
                          icon={PencilEdit02Icon}
                          strokeWidth={1.75}
                        />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Delete ${conn.name}`}
                        onClick={() => void remove(conn.id)}
                      >
                        <HugeiconsIcon icon={Delete02Icon} strokeWidth={1.75} />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <Button variant="outline" size="sm" onClick={startAdd}>
              <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
              Add connection
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The add/edit form. Controlled via the parent's `form` state object. */
function ConnectionForm({
  form,
  saving,
  error,
  onChange,
  onCancel,
  onSave,
}: {
  form: FormState;
  saving: boolean;
  error: string | null;
  onChange: (form: FormState) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  // Narrow helper so each field update keeps the rest of the form intact.
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    onChange({ ...form, [key]: value });

  return (
    <div className="flex flex-col gap-3">
      <Field label="Name">
        <Input
          value={form.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="My S3 bucket"
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Region">
          <Input
            value={form.region}
            onChange={(e) => set("region", e.target.value)}
            placeholder="us-east-1"
          />
        </Field>
        <Field label="Bucket (optional)">
          <Input
            value={form.bucket}
            onChange={(e) => set("bucket", e.target.value)}
            placeholder="my-bucket"
          />
        </Field>
      </div>
      <Field label="Endpoint (optional)">
        <Input
          value={form.endpoint}
          onChange={(e) => set("endpoint", e.target.value)}
          placeholder="https://s3.example.com"
        />
      </Field>

      <Label className="cursor-pointer">
        <Checkbox
          checked={form.forcePathStyle}
          onCheckedChange={(c) => set("forcePathStyle", c === true)}
        />
        <span className="text-[12.5px] font-normal">
          Force path-style addressing
        </span>
      </Label>

      <Field label="Access key ID">
        <Input
          value={form.accessKeyId}
          onChange={(e) => set("accessKeyId", e.target.value)}
          autoComplete="off"
        />
      </Field>
      <Field label="Secret access key">
        <Input
          type="password"
          value={form.secretAccessKey}
          onChange={(e) => set("secretAccessKey", e.target.value)}
          autoComplete="off"
        />
      </Field>
      <Field label="Session token (optional)">
        <Input
          type="password"
          value={form.sessionToken}
          onChange={(e) => set("sessionToken", e.target.value)}
          autoComplete="off"
        />
      </Field>

      {error ? (
        <div className="flex items-start gap-2 text-[12px] text-destructive">
          <HugeiconsIcon
            icon={Alert02Icon}
            size={14}
            strokeWidth={1.75}
            className="mt-0.5 shrink-0"
          />
          <span className="break-words">{error}</span>
        </div>
      ) : null}

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" onClick={onSave} disabled={saving}>
          {saving ? <Spinner className="size-3.5" /> : null}
          Save
        </Button>
      </div>
    </div>
  );
}

/** A labeled form field: a small uppercase label above its control. */
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className={cn("flex flex-col gap-1.5")}>
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}
