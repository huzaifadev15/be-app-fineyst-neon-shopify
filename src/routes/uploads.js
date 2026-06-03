import { Router } from "express";
import multer from "multer";
import { shopifyGraphql, SHOP_DOMAIN, accessToken } from "../lib/shopify.js";
import { validateSession } from "../middleware/validateSession.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// POST /uploads — upload an image to Shopify CDN
// Expects multipart/form-data with a single field named "file"
router.post("/", validateSession, upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded. Send a multipart field named 'file'." });
  }

  const { originalname, mimetype, size, buffer } = req.file;

  // Step 1: request a pre-signed S3 staged upload target from Shopify
  const stagedMutation = `
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters { name value }
        }
        userErrors { field message }
      }
    }
  `;

  let stagedTarget;
  try {
    const data = await shopifyGraphql(stagedMutation, {
      input: [
        {
          filename: originalname,
          mimeType: mimetype,
          fileSize: String(size),
          httpMethod: "POST",
          resource: "FILE",
        },
      ],
    });

    const { stagedTargets, userErrors } = data.stagedUploadsCreate;

    if (userErrors.length > 0) {
      return res.status(422).json({ error: "Staged upload creation failed", detail: userErrors });
    }

    stagedTarget = stagedTargets[0];
  } catch (err) {
    console.error("stagedUploadsCreate error:", err.message);
    return res.status(500).json({ error: "Failed to create staged upload", detail: err.message });
  }

  // Step 2: upload the file to the pre-signed S3 URL
  try {
    const form = new FormData();

    // S3 requires the policy parameters to come before the file field
    for (const { name, value } of stagedTarget.parameters) {
      form.append(name, value);
    }

    form.append("file", new Blob([buffer], { type: mimetype }), originalname);

    const s3Res = await fetch(stagedTarget.url, { method: "POST", body: form });

    if (!s3Res.ok) {
      const text = await s3Res.text();
      console.error("S3 upload failed:", text);
      return res.status(502).json({ error: "S3 upload failed", detail: text.slice(0, 300) });
    }
  } catch (err) {
    console.error("S3 upload error:", err.message);
    return res.status(500).json({ error: "Failed to upload to S3", detail: err.message });
  }

  // Step 3: register the file in Shopify Files
  const fileCreateMutation = `
    mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          ... on MediaImage {
            id
            fileStatus
            image { url }
          }
          ... on GenericFile {
            id
            fileStatus
            url
          }
        }
        userErrors { field message }
      }
    }
  `;

  let fileId;
  try {
    const data = await shopifyGraphql(fileCreateMutation, {
      files: [{ originalSource: stagedTarget.resourceUrl, contentType: "IMAGE" }],
    });

    const { files, userErrors } = data.fileCreate;

    if (userErrors.length > 0) {
      return res.status(422).json({ error: "File registration failed", detail: userErrors });
    }

    fileId = files[0]?.id;
  } catch (err) {
    console.error("fileCreate error:", err.message);
    return res.status(500).json({ error: "Failed to register file in Shopify", detail: err.message });
  }

  // Step 4: poll until Shopify finishes processing and returns a real CDN URL
  const pollQuery = `
    query getFile($id: ID!) {
      node(id: $id) {
        ... on MediaImage {
          id
          fileStatus
          image { url }
        }
        ... on GenericFile {
          id
          fileStatus
          url
        }
      }
    }
  `;

  const MAX_ATTEMPTS = 10;
  const POLL_INTERVAL_MS = 1500;

  let cdnUrl = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const data = await shopifyGraphql(pollQuery, { id: fileId });
      const node = data?.node;
      const status = node?.fileStatus;
      const url = node?.image?.url ?? node?.url;

      if (status === "READY" && url && !url.includes("staged-uploads")) {
        cdnUrl = url;
        break;
      }

      if (status === "FAILED") {
        return res.status(502).json({ error: "Shopify file processing failed" });
      }
    } catch (err) {
      console.error(`Poll attempt ${attempt + 1} error:`, err.message);
    }
  }

  if (!cdnUrl) {
    return res.status(504).json({
      error: "Timed out waiting for Shopify to process the image. Try again shortly.",
      resourceUrl: stagedTarget.resourceUrl,
    });
  }

  return res.status(201).json({
    success: true,
    url: cdnUrl,
    originalName: originalname,
    mimeType: mimetype,
    size,
  });
});

export default router;
