import {OrderService, ProductService, ProductVariant, TransactionBaseService} from "@medusajs/medusa"
import {EntityManager} from "typeorm"
import {PrintfulClient} from "../utils/printful-request"
import {
    CreateFulfillmentOrder,
    CreateShipmentConfig,
    FulFillmentItemType
} from "@medusajs/medusa/dist/types/fulfillment";
import {CreateProductInput, UpdateProductInput} from "@medusajs/medusa/dist/types/product";
import {kebabCase} from "lodash";
import {backOff, IBackOffOptions} from "exponential-backoff";

import {bgGreen, blue, bold, green, greenBright, red, redBright, yellow, yellowBright} from "colorette";

interface CalculateTaxRate {
    recipient: {
        country_code: string,
        state_code: string,
        city: string,
        zip: string
    }
}

class PrintfulService extends TransactionBaseService {

    protected manager_: EntityManager
    protected transactionManager_: EntityManager
    private productService: ProductService;
    private orderService: OrderService;
    private printfulClient: any;
    private readonly storeId: any;
    private readonly printfulAccessToken: any;
    private fulfillmentService: any;
    private productVariantService: any;
    private salesChannelService: any;
    private shippingProfileService: any;
    private apiKey: any;

    constructor(container, options) {
        super(container);
        this.productService = container.productService;
        this.orderService = container.orderService;
        this.fulfillmentService = container.fulfillmentService;
        this.productVariantService = container.productVariantService;
        this.printfulClient = new PrintfulClient(options.printfulAccessToken);
        this.shippingProfileService = container.shippingProfileService;
        this.salesChannelService = container.salesChannelService;
        this.storeId = options.storeId;
        this.apiKey = options.printfulAccessToken;
    }


    async getSyncProduct(id: string) {

        const {
            result: printfulStoreProduct,
            code
        } = await this.printfulClient.get(`store/products/${id}`, {store_id: this.storeId});

        if (code !== 200) {
            console.error("Error getting product from Printful: ", printfulStoreProduct)
            return null;
        }
        return printfulStoreProduct;
    }

    async getSyncVariant(id: string) {
        const {
            result: variant,
            code: code
        } = await this.printfulClient.get(`store/variants/${id}`, {store_id: this.storeId});
        if (code !== 200) {
            console.error("Error getting variant from Printful: ", variant)
            return null;
        }
        return variant;
    }

    convertToInteger(str) {
        // replace comma with period
        let numStr = str.replace(",", ".");
        // parse the number and round to the nearest integer
        let num = Math.round(parseFloat(numStr) * 100);
        return num;
    }

    buildProductImages(printfulVariants) {
        const images = printfulVariants.flatMap(variant => (
            variant.files
                .filter(file => file.type === 'preview')
                .map(file => file.preview_url)
        )).filter((url, index, arr) => arr.indexOf(url) === index && url !== null && url !== '');
        return images;
    }

    async createProductInMedusa(rawProduct: any) {

        const {
            sync_product: printfulSyncProduct,
            sync_variants: printfulSyncVariants

        } = rawProduct;

        const defaultShippingProfile = await this.shippingProfileService.retrieveDefault();
        const defaultSalesChannel = await this.salesChannelService.retrieveDefault();


        const printfulCatalogProductVariants = await Promise.all(printfulSyncVariants.map(async (v) => {
            const {result: {variant, product}} = await this.printfulClient.get(`products/variant/${v.variant_id}`);
            return {
                ...variant, parentProduct: product
            }
        }))


        function buildProductOptions() {
            const options = [];

            // Check if there are any variants with a non-null size option
            const hasSize = printfulCatalogProductVariants.some(variant => variant.size !== null);

            // Check if there are any variants with a non-null color option
            const hasColor = printfulCatalogProductVariants.some(variant => variant.color !== null);

            if (hasSize && hasColor) {
                // Include both size and color options
                options.push({title: "size"}, {title: "color"});
            } else if (hasSize) {
                // Only include size option
                options.push({title: "size"});
            } else if (hasColor) {
                // Only include color option
                options.push({title: "color"});
            }
            return options;
        }

        // const options =

        const productObj: CreateProductInput = {
            title: printfulSyncProduct.name,
            handle: kebabCase(printfulSyncProduct.name),
            thumbnail: printfulSyncProduct.thumbnail_url,
            options: buildProductOptions(),
            images: this.buildProductImages(printfulSyncVariants),
            profile_id: defaultShippingProfile.id,
            external_id: printfulSyncProduct.id,
            sales_channels: [{id: defaultSalesChannel.id}],
            metadata: {
                printful_id: printfulSyncProduct.id
            }
        };


        const productVariantsObj = await Promise.all(printfulSyncVariants.map(async (variant) => {
            const {result: {variant: option}} = await this.printfulClient.get(`products/variant/${variant.variant_id}`);

            const productSizeGuide = await this.getProductSizeGuide(variant.product.product_id);

            const options = {
                ...(option.size ? {size: option.size} : {}),
                ...(option.color ? {color: option.color} : {}),
                ...(option.color_code ? {color_code: option.color_code} : {})
            }

            return {
                title: productObj.title + (option.size ? ` - ${option.size}` : '') + (option.color ? ` / ${option.color}` : ''),
                sku: variant.sku,
                external_id: variant.id,
                manage_inventory: false,
                allow_backorder: true,
                inventory_quantity: 100,
                prices: [{
                    amount: this.convertToInteger(variant.retail_price),
                    currency_code: variant.currency.toLowerCase()
                }],
                metadata: {
                    printful_id: variant.id,
                    printful_catalog_variant_id: variant.variant_id,
                    printful_product_id: variant.product.product_id,
                    printful_catalog_product_id: variant.product.id,
                    size_tables: productSizeGuide?.size_tables ?? null,
                    ...options
                }
            }
        }))
        const productToPush = {
            ...productObj,
            variants: productVariantsObj,
        }
        const createProductInMedusaWithRetry = async () => {
            try {
                const createdProduct = await this.productService.create(productToPush);
                console.log('Created product in Medusa:', productToPush);
                return createdProduct;
            } catch (error) {
                console.error('Error creating product in Medusa:', error);
                throw error;
            }
        };
        const options: Partial<IBackOffOptions> = {
            jitter: 'full',
            numOfAttempts: 3,
            retry: (e: any, attempts: number) => {
                console.error(`${yellow(`Attempt ${yellowBright(`${attempts}`)} failed with error: ${e.message}`)}`);
                return true;
            }
        }
        try {
            const createdProduct = await backOff(createProductInMedusaWithRetry, options);
            console.log(green(`Created product in Medusa: ${greenBright(`${createdProduct.id}`)}`))
            if (createdProduct) {
                console.log('Trying to add options to variants...');
                const {variants, options} = await this.productService.retrieve(createdProduct.id, {
                    relations: ['variants', 'options'],
                });


                for (const option of options) {
                    for (const variant of variants) {
                        if (option.title === 'size' || option.title === 'color') {
                            const value = variant.metadata[option.title];
                            console.log(`Variant ${variant.id}: option ${option.title} = ${value} ℹ️`);
                            // if (value !== undefined && option.values && value !== option.values[0].value) {
                            if (value !== null) {
                                console.log(`Updating variant ${variant.id} option ${option.id} to ${value}.. ⚙️`);
                                const addedOption = await this.productVariantService.addOptionValue(variant.id, option.id, value);
                                if (addedOption) {
                                    console.log(`Updated variant ${variant.id} option ${option.id} to ${value}! ✅`);
                                }
                            }
                            // }
                        }
                    }
                }
            }
        } catch (e) {
            console.error(red(`There appeared an error when trying to create a product in Medusa: `), e)
        }
    }


    async updateProduct(rawProduct: any, type: string, data: any) {

        if (type === 'fromPrintful') {

            const {
                sync_product: printfulProduct,
                sync_variants: printfulProductVariant,
                medusa_product: medusaProduct

            } = rawProduct;


            const variantsToDelete = medusaProduct.variants.filter(v => !printfulProductVariant.find(pv => pv.id === v.metadata.printful_id));

            if (variantsToDelete.length > 0) {
                console.log(`${yellowBright("Deleting variants unsynced with Printful...")} 🚮`);
                for (const variant of variantsToDelete) {
                    await this.deleteProductVariant(variant.id);
                }
            }


            const productObj: UpdateProductInput = {
                title: printfulProduct.name,
                handle: kebabCase(printfulProduct.name),
                thumbnail: printfulProduct.thumbnail_url,
                external_id: printfulProduct.id,
                images: this.buildProductImages(printfulProductVariant),
                metadata: {
                    printful_id: printfulProduct.id,
                }
            }


            const productSizeGuide = await this.getProductSizeGuide(printfulProductVariant[0].product.product_id);

            const productVariantsObj = await Promise.all(printfulProductVariant.map(async (variant) => {
                const {result: {variant: option}} = await this.printfulClient.get(`products/variant/${variant.variant_id}`);

                const medusaVariant = medusaProduct.variants.find(v => v.metadata.printful_id === variant.id);

                if (medusaVariant !== undefined) {
                    const title = productObj.title + (option.size ? ` - ${option.size}` : '') + (option.color ? ` / ${option.color}` : '');
                    const metadata = {
                        medusa_id: medusaVariant.id,
                        printful_id: variant.id,
                        printful_catalog_variant_id: variant.variant_id,
                        size: option.size,
                        color: option.color,
                        color_code: option.color_code,
                        ...productSizeGuide
                    };

                    return {
                        title,
                        sku: variant.sku,
                        prices: [{
                            amount: this.convertToInteger(variant.retail_price),
                            currency_code: variant.currency.toLowerCase()
                        }],
                        metadata
                    };
                } else {
                    console.log(blue(`Variant with SKU '${variant.sku}' not found in Medusa! Attempting to create...`));
                    const sizeOptionId = medusaProduct.options.find(o => o.title === 'size').id;
                    const colorOptionId = medusaProduct.options.find(o => o.title === 'color').id;
                    const options = [
                        {
                            option_id: sizeOptionId,
                            value: option.size
                        },
                        {
                            option_id: colorOptionId,
                            value: option.color
                        }
                    ];

                    const newVariant = await this.productVariantService.create(medusaProduct.id, {
                        title: `${productObj.title} - ${option.size} / ${option.color}`,
                        sku: variant.sku,
                        inventory_quantity: 100,
                        allow_backorder: true,
                        manage_inventory: false,
                        external_id: variant.id,
                        options,
                        prices: [{
                            amount: this.convertToInteger(variant.retail_price),
                            currency_code: variant.currency.toLowerCase()
                        }],
                        metadata: {
                            printful_id: variant.id,
                            size: option.size,
                            color: option.color,
                            color_code: option.color_code
                        }
                    });

                    if (newVariant) {
                        await this.productVariantService.update(newVariant.id, {metadata: {medusa_id: newVariant.id}});
                        console.log(`Successfully created variant ${newVariant.id} for product ${medusaProduct.id}! 🎉`);
                    }
                }
            }));


            try {
                const updatedProduct = await this.productService.update(medusaProduct.id, productObj);
                console.log(`Updated '${updatedProduct.title}' in Medusa! 🎉`);

                const updatedVariants = await Promise.all(productVariantsObj.map(async (variant) => {
                    const variantToUpdate = await this.productVariantService.update(variant.metadata.medusa_id, {
                        title: variant.title,
                        sku: variant.sku,
                        metadata: variant.metadata,
                        external_id: variant.external_id,
                    });
                    if (variantToUpdate) {
                        return variantToUpdate;
                    }
                }));

                if (updatedVariants) {
                    console.log(`Also updated '${updatedVariants.length}' variants from '${updatedProduct.title}' in Medusa! 🥳`);

                    const {variants, options} = await this.productService.retrieve(updatedProduct.id, {
                        relations: ['variants', 'options'],
                    });

                    variants.map(async (variant) => {
                        options.map(async (option) => {
                            if (option.title === 'size' || option.title === 'color') {
                                const value = variant.metadata[option.title];
                                if (value !== null) {
                                    const addedOption = await this.productVariantService.updateOptionValue(variant.id, option.id, value);
                                    if (!addedOption) {
                                        console.log(`Failed to add option value ${red(`${value}`)} to variant ${variant.id}!`);
                                    }
                                }
                            }
                        });
                    });

                    try {
                        console.log(blue(`Trying to update options on variants..`))
                        const updateVariantOptionsPromises = variants.map(async (variant) => {
                            const optionValues = {};
                            options.map((option) => {
                                if (option.title === 'size' || option.title === 'color' || option.title === 'color_code') {
                                    optionValues[option.id] = variant.metadata[option.title];
                                }
                            });
                            for (const optionId in optionValues) {
                                await this.productVariantService.updateOptionValue(variant.id, optionId, optionValues[optionId]);
                            }
                        });
                        await Promise.all(updateVariantOptionsPromises);
                        console.log(green(`Updated options on several variants! 🔍`));
                    } catch (e) {
                        console.error("Error updating options on variants: ", e);
                    }

                    try {
                        console.log(blue(`Trying to update prices on variants..`))
                        const updateVariantPricesPromises = productVariantsObj.map(async (variant) => {
                            await this.productVariantService.updateVariantPrices(variant.metadata.medusa_id, variant.prices);
                        });

                        await Promise.all(updateVariantPricesPromises);
                        console.log(green(`Updated prices on several variants! 💰`));
                    } catch (e) {
                        console.error("Error updating prices on variants: ", e);
                    }
                }
            } catch (e) {
                console.error("Error updating product in Medusa: ", e);
            }
            return "Could not update product";
        }

    }


    async getProductSizeGuide(printfulProductId) {
        console.log("Trying to get size guide for product: ", printfulProductId)
        try {
            const {result, code} = await this.printfulClient.get(`products/${printfulProductId}/sizes`, {unit: 'cm'});
            if (code === 200) {
                return result;
            }
        } catch (e: any) {
            console.log(e)
        }
    }

    async deleteProduct(productOrProductId: string) {
        try {
            await this.productService.delete(productOrProductId);
            console.log(green(`Successfully deleted product ${productOrProductId} in Medusa 🪦`))
        } catch (e) {
            console.log(`Failed to delete product ${productOrProductId} in Medusa 🙇‍♂️`)
        }
    }

    async deleteProductVariant(variantOrVariantId: string) {
        try {
            await this.productVariantService.delete(variantOrVariantId);
            console.log(green(`Successfully deleted variant ${variantOrVariantId} in Medusa 🪦`))
        } catch (e) {
            console.log(red(`Failed to delete product ${variantOrVariantId} in Medusa 🙇‍`))
        }
    }

    async getShippingRates(data) {
        console.log("Trying to get shipping rates for: ", data)
        const {recipient, items} = data;
        try {
            const shippingRates = await this.printfulClient.post("shipping/rates", {
                recipient,
                items,
                store_id: this.storeId
            });
            console.log(shippingRates)
            return shippingRates;
        } catch (e) {
            console.log(e)
            return 0
        }
    }

    async getCountryList() {
        const {result: countries} = await this.printfulClient.get("countries", {store_id: this.storeId});
        if (countries) return countries;
    }

    async getTaxCountriesList() {
        const {result: taxCountries} = await this.printfulClient.get("tax/countries", {store_id: this.storeId});
        if (taxCountries) return taxCountries;
    }

    async calculateTaxRate(recipient: CalculateTaxRate) {
        const {result: taxRate} = await this.printfulClient.post("tax/rates", {recipient}, {store_id: this.storeId});
        if (taxRate) return taxRate;
    }

    async estimateOrderCosts(recipient: any, items: any) {
        const {result: orderCosts} = await this.printfulClient.post("orders/estimate-costs", {
            recipient,
            items
        }, {store_id: this.storeId});

        return orderCosts;
    }

    async createPrintfulOrder(data: any) {
        console.log("Preparing order data for Printful..: ", data)
        console.log(data.items[0].variant)
        console.log("shipping method", data.shipping_methods[0].shipping_option)
        const orderObj = {
            external_id: data.id,
            shipping: data.shipping_methods[0].shipping_option.data.id,
            recipient: {
                name: data.shipping_address.first_name + " " + data.shipping_address.last_name,
                address1: data.shipping_address.address_1,
                address2: data.shipping_address.address_2,
                city: data.shipping_address.city,
                state_code: data.shipping_address.province,
                country_code: data.shipping_address.country_code,
                zip: data.shipping_address.postal_code,
                email: data.email,
                phone: data.shipping_address.phone
            },
            items: data.items.map((item) => {
                return {
                    name: item.variant.title,
                    external_id: item.id,
                    variant_id: item.variant.metadata.printful_catalog_variant_id,
                    sync_variant_id: item.variant.metadata.printful_id,
                    quantity: item.quantity,
                    price: `${(item.unit_price / 100).toFixed(2)}`.replace('.', '.'),
                    retail_price: `${(item.unit_price / 100).toFixed(2)}`.replace('.', '.'),
                }
            })
        }
        try {
            console.log("Sending order to Printful with the following data... ➡️", orderObj)
            const order = await this.printfulClient.post("orders", {
                ...orderObj,
                store_id: this.storeId,
                confirm: false
            });
            if (order.code === 200) {
                console.log("Order successfully sent to Printful! 📬🥳: ", order.result)
            }
        } catch (e) {
            console.log(e)
        }
    }

    async cancelOrder(orderId: string | number) {
        try {
            console.log("store id", this.storeId)
            const {result, code} = await this.printfulClient.delete(`orders/@${orderId}`, {store_id: this.storeId});

            if (code === 200) {
                console.log("Order has been canceled on Printful!", result)
                return result;
            } else {
                console.log("Order was not canceled on Printful!", result)
                return result;
            }
        } catch (e) {
            console.log(e)
        }
    }

    async confirmDraftForFulfillment(orderId: string | number) {
        const confirmedOrder = await this.printfulClient.post(`orders/${orderId}/confirm`, {store_id: this.storeId});
        console.log(confirmedOrder)
        return confirmedOrder;
    }

    async getOrderData(orderId: string | number) {
        const {result: orderData} = await this.printfulClient.get(`orders/${orderId}`, {store_id: this.storeId});
        return orderData;
    }

    async createMedusaFulfillment(order: CreateFulfillmentOrder, itemsToFulfill: FulFillmentItemType[]) {


        console.log("LENGTH", itemsToFulfill.length)

        const fulfillmentItems = await this.fulfillmentService.getFulfillmentItems_(order, itemsToFulfill);
        console.log("FULFILLMENT ITEMS", fulfillmentItems)


        return await this.fulfillmentService.createFulfillment(order, itemsToFulfill);
    }

    async createMedusaShipment(fulfillmentId: string, trackingLinks: { tracking_number: string }[], config: CreateShipmentConfig) {
        return await this.fulfillmentService.createShipment(fulfillmentId, trackingLinks, config);
    }
}

export default PrintfulService;