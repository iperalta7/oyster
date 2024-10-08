import { z } from 'zod';

import { type Address } from '@oyster/types';

import { redis } from '@/infrastructure/redis';
import {
  OAuthTokenResponse,
  type OAuthTokens,
} from '@/modules/authentication/oauth.service';
import { ENV, IS_PRODUCTION } from '@/shared/env';
import { ErrorWithContext } from '@/shared/errors';
import { encodeBasicAuthenticationToken } from '@/shared/utils/auth.utils';
import { validate } from '@/shared/utils/zod.utils';

// Errors

class SwagUpApiError extends ErrorWithContext {
  message = 'There was an issue fetching data from the SwagUp API.';
}

// Constants

const SWAG_UP_API_URL = 'https://api.swagup.com/api/v1';

// Core

type OrderSwagPackInput = {
  contact: {
    address: Address;
    email: string;
    firstName: string;
    lastName: string;
  };
};

type SwagUpSendRequestBody = {
  employee: {
    first_name: string;
    last_name: string;
    email: string;
    shipping_address1: string;
    shipping_address2?: string;
    shipping_city: string;
    shipping_country: string;
    shipping_state: string;
    shipping_zip: string;
  };
  force_address: boolean;
  products: {
    product: number;
    sizes: {
      quantity: number;
      size: number;
    }[];
  }[];
};

const SwagPackOrder = z.object({
  id: z.number(),
});

class SwagPackOrderError extends ErrorWithContext {
  message = 'There was an issue ordering a swag pack.';
}

export async function orderSwagPack(input: OrderSwagPackInput) {
  if (!IS_PRODUCTION) {
    return null;
  }

  const { accessToken } = await retrieveTokens();

  const { productId, sizeId } = await getProductInformation();

  const body: SwagUpSendRequestBody = {
    employee: {
      email: input.contact.email,
      first_name: input.contact.firstName,
      last_name: input.contact.lastName,
      shipping_address1: input.contact.address.line1,
      shipping_address2: input.contact.address.line2,
      shipping_city: input.contact.address.city,
      shipping_country: input.contact.address.country,
      shipping_state: input.contact.address.state,
      shipping_zip: input.contact.address.zip,
    },
    products: [
      {
        product: productId,
        sizes: [
          {
            quantity: 1,
            size: sizeId,
          },
        ],
      },
    ],
    force_address: true,
  };

  const response = await fetch(`${SWAG_UP_API_URL}/employee-orders/`, {
    body: JSON.stringify([body]),
    method: 'post',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new SwagPackOrderError().withContext({
      body,
      error: data,
    });
  }

  const [order] = validate(SwagPackOrder.array(), data);

  console.log({
    code: 'swag_pack_ordered',
    message: 'Swag pack was ordered.',
    data: {
      email: input.contact.email,
      firstName: input.contact.firstName,
      lastName: input.contact.lastName,
      orderId: order.id,
    },
  });

  return order.id.toString();
}

const SwagProduct = z.object({
  stock: z.object({ quantity: z.coerce.number() }).array(),
});

export async function getSwagPackInventory() {
  const { productId } = await getProductInformation();

  const { accessToken } = await retrieveTokens();

  const response = await fetch(
    `${SWAG_UP_API_URL}/account-products/${productId}/`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    throw new SwagUpApiError().withContext({ productId });
  }

  const product = validate(SwagProduct, await response.json());

  const inventory = product.stock[0].quantity || 0;

  return inventory;
}

const SwagProductInformation = z.object({
  productId: z.coerce.number(),
  sizeId: z.coerce.number(),
});

async function getProductInformation() {
  const [productId, sizeId] = await Promise.all([
    redis.get('swag_up:product_id'),
    redis.get('swag_up:size_id'),
  ]);

  const result = SwagProductInformation.safeParse({
    productId,
    sizeId,
  });

  if (!result.success) {
    throw new Error(
      'SwagUp information was either not found or misformatted in Redis.'
    );
  }

  return result.data;
}

// Authentication

async function retrieveTokens(): Promise<OAuthTokens> {
  const [accessToken = '', refreshToken = ''] = await Promise.all([
    redis.get('swag_up:access_token'),
    redis.get('swag_up:refresh_token'),
  ]);

  if (!accessToken || !refreshToken) {
    throw new Error(
      'There was some token(s) not found. Please reauthenticate via the SwagUp OAuth 2.0 flow.'
    );
  }

  // This is just hitting a dummy endpoint on the SwagUp API to ensure that
  // the access token is working properly (not expired, etc). Ideally,
  // SwagUp would have an endpoint like POST /token/test to know if the
  // token needed to be refreshed or not, but this is our current
  // workaround.
  const response = await fetch(`${SWAG_UP_API_URL}/accounts?limit=1`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (response.ok) {
    return {
      accessToken,
      refreshToken,
    };
  }

  const { access_token: newAccessToken, refresh_token: newRefreshToken } =
    await refreshAuthentication(refreshToken);

  await Promise.all([
    redis.set('swag_up:access_token', newAccessToken),
    redis.set('swag_up:refresh_token', newRefreshToken),
  ]);

  return {
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
  };
}

async function refreshAuthentication(
  refreshToken: string
): Promise<OAuthTokenResponse> {
  const url = new URL('https://signin.swagup.com/oauth2/default/v1/token');

  url.searchParams.set('grant_type', 'refresh_token');
  url.searchParams.set('refresh_token', refreshToken);

  const basicToken = encodeBasicAuthenticationToken(
    ENV.SWAG_UP_CLIENT_ID,
    ENV.SWAG_UP_CLIENT_SECRET
  );

  const response = await fetch(url, {
    method: 'post',
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${basicToken}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });

  const data = validate(OAuthTokenResponse, await response.json());

  return data;
}
