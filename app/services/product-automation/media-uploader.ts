import fs from "node:fs";
import path from "node:path";
import type { AdminGraphqlClient } from "./shopify-client.ts";
import { executeGraphQL } from "./shopify-client.ts";

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    default:
      return "image/jpeg";
  }
}

/**
 * Attach media to a product using either remote URL or local staged upload
 */
export async function attachProductMedia(
  admin: AdminGraphqlClient,
  productId: string,
  link: string,
  altText: string,
): Promise<boolean> {
  const trimmed = link.trim();
  if (!trimmed) {
    return false;
  }

  // Local file path
  const resolvedPath = path.isAbsolute(trimmed)
    ? trimmed
    : path.resolve(process.cwd(), trimmed);

  if (!fs.existsSync(resolvedPath)) {
    console.warn(`Media file does not exist locally: ${resolvedPath}`);
    return false;
  }

  return uploadLocalMedia(admin, productId, resolvedPath, altText);
}

/**
 * Attach remote image URL to Shopify product
 */
async function attachRemoteMedia(
  admin: AdminGraphqlClient,
  productId: string,
  url: string,
  altText: string,
): Promise<boolean> {
  const mutation = `#graphql
    mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        media {
          id
          status
        }
        mediaUserErrors {
          field
          message
        }
      }
    }
  `;

  interface MediaData {
    productCreateMedia?: {
      media?: Array<{ id: string; status: string }>;
      mediaUserErrors?: Array<{ field: string[]; message: string }>;
    };
  }

  const variables = {
    productId,
    media: [
      {
        originalSource: url,
        mediaContentType: "IMAGE",
        alt: altText,
      },
    ],
  };

  const data = await executeGraphQL<MediaData>(admin, mutation, variables);
  const userErrors = data?.productCreateMedia?.mediaUserErrors;

  if (userErrors && userErrors.length > 0) {
    const errorMsgs = userErrors.map((u) => `${u.field?.join(".")}: ${u.message}`).join("; ");
    console.warn(`Remote media attachment warning for product ${productId}: ${errorMsgs}`);
    return false;
  }

  return true;
}

/**
 * Staged upload for local media file and attach to product
 */
async function uploadLocalMedia(
  admin: AdminGraphqlClient,
  productId: string,
  localFilePath: string,
  altText: string,
): Promise<boolean> {
  const filename = path.basename(localFilePath);
  const mimeType = getMimeType(localFilePath);
  const stats = fs.statSync(localFilePath);
  const fileSize = stats.size.toString();

  const stagedUploadMutation = `#graphql
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters {
            name
            value
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  interface StagedUploadData {
    stagedUploadsCreate?: {
      stagedTargets?: Array<{
        url: string;
        resourceUrl: string;
        parameters: Array<{ name: string; value: string }>;
      }>;
      userErrors?: Array<{ field: string[]; message: string }>;
    };
  }

  const stagedData = await executeGraphQL<StagedUploadData>(admin, stagedUploadMutation, {
    input: [
      {
        resource: "IMAGE",
        filename,
        mimeType,
        httpMethod: "POST",
        fileSize,
      },
    ],
  });

  const stagedErrors = stagedData?.stagedUploadsCreate?.userErrors;
  if (stagedErrors && stagedErrors.length > 0) {
    const msgs = stagedErrors.map((e) => e.message).join("; ");
    console.warn(`stagedUploadsCreate failed for ${filename}: ${msgs}`);
    return false;
  }

  const target = stagedData?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target) {
    console.warn(`stagedUploadsCreate returned no target for ${filename}`);
    return false;
  }

  // Upload the binary file to target.url using standard Fetch FormData
  try {
    const fileBuffer = fs.readFileSync(localFilePath);
    const formData = new FormData();

    for (const param of target.parameters) {
      formData.append(param.name, param.value);
    }
    const blob = new Blob([fileBuffer], { type: mimeType });
    formData.append("file", blob, filename);

    const uploadResponse = await fetch(target.url, {
      method: "POST",
      body: formData,
    });

    if (!uploadResponse.ok) {
      const errText = await uploadResponse.text();
      console.warn(`Failed to upload media to staged URL: ${uploadResponse.status} - ${errText}`);
      return false;
    }

    // Now attach resourceUrl to product
    return attachRemoteMedia(admin, productId, target.resourceUrl, altText);
  } catch (err) {
    console.warn(`Exception uploading local media for ${filename}:`, err);
    return false;
  }
}
