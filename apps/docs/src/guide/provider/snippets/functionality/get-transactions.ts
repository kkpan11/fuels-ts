// #region getTransactions
import { Provider } from 'fuels';

import { LOCAL_NETWORK_URL } from '../../../../env';

const provider = new Provider(LOCAL_NETWORK_URL);

const { transactions } = await provider.getTransactions();
// #endregion getTransactions

console.log('transactions', transactions);
