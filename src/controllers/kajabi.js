import { kajabi } from "../config/kajabi.js";

export async function getAllMembers() {
  try {
    console.log("here");

    const res = await kajabi.get("/site_members");

    return res.data;
  } catch (err) {
    console.error("Error fetching Kajabi members:", err.response?.data || err);
    throw err;
  }
}
export async function getCustomerByEmail(email) {
  try {
    const res = await kajabi.get("/v1/customers", {
      params: {
        "filter[email_contains]": email,
        "fields[customers]": "name,email",
        "page[size]": 1,
      },
    });

    // Customers array
    const customers = res.data?.data || [];

    // Return first match or null
    return customers.length > 0 ? customers[0] : null;
  } catch (err) {
    console.error(
      "Error fetching Kajabi user by email:",
      err.response?.data || err
    );
    throw err;
  }
}

export async function getCustomerFullDetails(customerId) {
  try {
    const res = await kajabi.get(`/v1/customers/${customerId}`, {
      params: {
        include: "products,offers,tags,subscriptions,assessments",
      },
    });

    return res.data;
  } catch (err) {
    console.error(
      "Error fetching customer details:",
      err.response?.data || err
    );
    throw err;
  }
}
